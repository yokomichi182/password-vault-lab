import { execFile, spawn } from "node:child_process";
import { CliError } from "./ctx.ts";

export const CONCEALED = "<concealed by pwm>";
const MARKER = Buffer.from(CONCEALED, "utf8");

/**
 * 子の出力の中の値を `<concealed by pwm>` に置き換える。
 * チャンクの切れ目にまたがる値も置き換えるため、値の最大の長さぶん(-1)を次に持ち越す。
 * 値を変形した出力(base64、逆順、一部だけなど)は置き換えられない(既知の限界)。
 */
export class Concealer {
  private readonly needles: Buffer[];
  private readonly maxLen: number;
  private carry: Buffer = Buffer.alloc(0);

  constructor(values: string[]) {
    const uniq = [...new Set(values.filter((v) => v !== ""))];
    // 長い値を先に当てる(短い値が長い値の一部のとき、長い方で置き換える)
    this.needles = uniq.map((v) => Buffer.from(v, "utf8")).sort((a, b) => b.length - a.length);
    this.maxLen = this.needles.length > 0 ? this.needles[0]!.length : 0;
  }

  private process(raw: Buffer, final: boolean): Buffer {
    if (this.needles.length === 0) return raw;
    const safeEnd = final ? raw.length + 1 : Math.max(0, raw.length - this.maxLen + 1);
    const out: Buffer[] = [];
    let i = 0;
    for (;;) {
      let bestStart = -1;
      let bestLen = 0;
      for (const n of this.needles) {
        const at = raw.indexOf(n, i);
        if (at < 0) continue;
        if (bestStart < 0 || at < bestStart || (at === bestStart && n.length > bestLen)) {
          bestStart = at;
          bestLen = n.length;
        }
      }
      if (bestStart < 0 || bestStart >= safeEnd) break;
      out.push(raw.subarray(i, bestStart), MARKER);
      i = bestStart + bestLen;
    }
    const cursor = final ? raw.length : Math.max(i, safeEnd);
    out.push(raw.subarray(i, cursor));
    this.carry = Buffer.from(raw.subarray(cursor));
    return Buffer.concat(out);
  }

  push(chunk: Buffer): Buffer {
    return this.process(Buffer.concat([this.carry, chunk]), false);
  }

  flush(): Buffer {
    return this.process(this.carry, true);
  }
}

export interface RunOptions {
  command: string[];
  /** 今の環境に足す変数 */
  extraEnv: Record<string, string>;
  baseEnv: Record<string, string | undefined>;
  /** 置き換える値(入れた値) */
  values: string[];
  timeoutMs: number;
  stdin: "inherit" | "ignore";
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
}

function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid !== undefined && process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    fallback();
  }
}

/** 子をシェルを通さずに起動し、出力の値を伏せて渡す。子の終了コードを返す(時間切れは 124)。 */
export function runChild(opts: RunOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.baseEnv)) if (v !== undefined) env[k] = v;
    Object.assign(env, opts.extraEnv);
    let child;
    try {
      child = spawn(opts.command[0]!, opts.command.slice(1), {
        shell: false,
        env,
        stdio: [opts.stdin, "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(new CliError("spawnFailed", {}, 127));
      return;
    }
    const outC = new Concealer(opts.values);
    const errC = new Concealer(opts.values);
    let timedOut = false;
    let failed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, () => child.kill("SIGKILL"));
    }, opts.timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      const b = outC.push(d);
      if (b.length > 0) opts.onStdout(b);
    });
    child.stderr!.on("data", (d: Buffer) => {
      const b = errC.push(d);
      if (b.length > 0) opts.onStderr(b);
    });
    child.on("error", () => {
      failed = true;
      clearTimeout(timer);
      reject(new CliError("spawnFailed", {}, 127));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      const tailOut = outC.flush();
      if (tailOut.length > 0) opts.onStdout(tailOut);
      const tailErr = errC.flush();
      if (tailErr.length > 0) opts.onStderr(tailErr);
      resolve(timedOut ? 124 : (code ?? 1));
    });
  });
}

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** `NAME=参照` を分け、名前を検査する(既存の変数の上書きは不可)。 */
export function parseEnvSpec(spec: string, baseEnv: Record<string, string | undefined>): { name: string; ref: string } {
  const i = spec.indexOf("=");
  if (i < 0) throw new CliError("badEnvSpec");
  const name = spec.slice(0, i);
  const ref = spec.slice(i + 1);
  if (!ENV_NAME_RE.test(name) || ref === "") throw new CliError("badEnvSpec");
  const lower = name.toLowerCase();
  if (Object.keys(baseEnv).some((k) => k.toLowerCase() === lower)) throw new CliError("envExists");
  return { name, ref };
}
