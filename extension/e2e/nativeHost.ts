import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// フェーズ5 の Playwright(実装指示 4-2): Native Messaging のホスト pwm-bridge を、テスト用の名前で登録して使う。
// 登録するのは、テスト用の名前 com.pwm.bridge.test だけ(本物の com.pwm.bridge は登録しない)。場所は、
// Playwright が使う Chromium(Chrome ではない)が読む HKCU の Software\Chromium\NativeMessagingHosts。
// テストの終わりに必ず消す(失敗したときも。プロセスが終わるときにも消す)。
export const HOST_NAME = "com.pwm.bridge.test";
export const REG_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`;
/** 本物の名前の場所。このテストは触らない(触っていないことの確認だけに使う) */
export const REAL_REG_KEYS = [
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.pwm.bridge",
  "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.pwm.bridge",
];

const root = path.resolve(import.meta.dirname, "..", "..");
const cliDist = path.join(root, "cli", "dist", "test");
export const PWM_JS = path.join(cliDist, "pwm.mjs");
export const PWM_MCP_JS = path.join(cliDist, "pwm-mcp.mjs");

export function regKeyExists(key: string): boolean {
  try {
    execFileSync("reg", ["query", key], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function regDelete(key: string): void {
  try {
    execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
  } catch {
    // 無ければ何もしない
  }
}

export interface NativeHost {
  /** pwm-bridge の見張る置き場の親(PWM_HOME) */
  home: string;
  dir: string;
  /** 登録を消し、一時フォルダを消す(何度呼んでもよい) */
  dispose(): Promise<void>;
}

let exitHookInstalled = false;

/** テスト用のホストを作って登録する。 */
export async function registerNativeHost(): Promise<NativeHost> {
  for (const f of ["pwm.mjs", "pwm-mcp.mjs", "pwm-bridge.mjs"]) {
    if (!existsSync(path.join(cliDist, f))) throw new Error(`cli/dist/test/${f} not found. Run "node build.mjs" in cli/ first.`);
  }
  // 前の実行が途中で止まって残った登録があれば消す
  regDelete(REG_KEY);
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwm-e2e-nm-")); // ASCII だけの場所に置く(.cmd の読み込みの文字コードを避ける)
  const home = await mkdtemp(path.join(os.tmpdir(), "pwm-e2e-home-"));
  copyFileSync(path.join(cliDist, "pwm-bridge.mjs"), path.join(dir, "pwm-bridge.mjs"));
  execFileSync(
    process.execPath,
    [path.join(root, "cli", "bridge-manifest.mjs"), dir, "--name", HOST_NAME, "--home", home, "--dist", dir],
    { stdio: "ignore" },
  );
  const manifest = path.join(dir, `${HOST_NAME}.json`);
  execFileSync("reg", ["add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore" });

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => regDelete(REG_KEY)); // 異常終了でも、登録を残さない
  }
  let disposed = false;
  return {
    home,
    dir,
    async dispose() {
      if (disposed) return;
      disposed = true;
      regDelete(REG_KEY);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export interface PwmResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 実際の pwm fill(テスト用のビルド)を動かす。置き場は PWM_HOME(一時フォルダ)。 */
export function runPwmFill(home: string, title: string, url?: string): { done: Promise<PwmResult> } {
  const args = [PWM_JS, "fill", "--title", title];
  if (url !== undefined) args.push("--url", url);
  const child = spawn(process.execPath, args, {
    env: { ...process.env, PWM_HOME: home, PWM_LANG: "en" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return { done: new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr }))) };
}

/** pwm-mcp(テスト用のビルド)を標準入出力で動かす、最小の MCP クライアント。 */
export class RawMcp {
  stderr = "";
  stdout = "";
  private id = 0;
  private waiters = new Map<number, (v: unknown) => void>();
  private child;
  constructor(home: string) {
    this.child = spawn(process.execPath, [PWM_MCP_JS], {
      env: { ...process.env, PWM_HOME: home, PWM_LANG: "en" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buf = "";
    this.child.stdout.on("data", (d: Buffer) => {
      this.stdout += d.toString("utf8");
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id !== undefined) this.waiters.get(msg.id)?.(msg);
      }
    });
    this.child.stderr.on("data", (d: Buffer) => (this.stderr += d.toString("utf8")));
  }
  request(method: string, params: unknown): Promise<{ result?: { content?: { text: string }[] } }> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve as (v: unknown) => void);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async init(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e-mcp-client", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async tool(name: string, args: unknown): Promise<string> {
    const r = await this.request("tools/call", { name, arguments: args });
    return (r.result?.content ?? []).map((c) => c.text).join("");
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => this.child.once("close", r));
  }
}

/** 置き場(<PWM_HOME>\bridge\)に残っているファイルの名前(カナリアの探査と、残りの確認用) */
export async function bridgeFiles(home: string): Promise<string[]> {
  return readdir(path.join(home, "bridge")).catch(() => [] as string[]);
}

export async function readBridgeText(home: string): Promise<string> {
  const dir = path.join(home, "bridge");
  const names = await bridgeFiles(home);
  const parts: string[] = [];
  for (const n of names) parts.push(await readFile(path.join(dir, n), "utf8").catch(() => ""));
  return parts.join("\n");
}
