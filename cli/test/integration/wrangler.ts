import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// リポジトリのルート。ソースから(cli/test/integration)も、束ねた dist/serve-check.mjs からも同じ場所を指すよう、worker/ と cli/ がある所まで上る
function findRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "worker", "src")) && existsSync(path.join(dir, "cli", "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("repository root not found");
}
export const root = findRoot();
export const WRANGLER_PORT = Number(process.env.PWM_IT_WRANGLER_PORT ?? 18789);
export const SYNC_URL = `http://127.0.0.1:${WRANGLER_PORT}`;

export interface Wrangler {
  dir: string;
  stop(): Promise<void>;
  /** 標準出力と標準エラー(カナリアの探査用) */
  output(): string;
}

async function waitPort(port: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

/**
 * 拡張の e2e/support.ts と同じやり方。設定ファイルと状態を作業フォルダの外の一時フォルダに置き、
 * `.dev.vars` は読まず、`--var TOKENS:...` で架空のトークン表(SHA-256 → 保管庫の名前)を渡す。
 */
export async function startWrangler(tokens: Record<string, string>): Promise<Wrangler> {
  const dir = path.join(os.tmpdir(), `pwm-it-wrangler-${process.pid}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const worker = path.join(root, "worker").replaceAll("\\", "/");
  await writeFile(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "pwm-worker",
      main: `${worker}/src/index.ts`,
      compatibility_date: "2026-08-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "pwm",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: `${worker}/migrations`,
        },
      ],
    }),
  );
  const bin = path.join(root, "worker", "node_modules", "wrangler", "bin", "wrangler.js");
  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  const state = path.join(dir, "state");
  await run(process.execPath, [bin, "d1", "migrations", "apply", "pwm", "--local", "--persist-to", state], dir, env);

  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const table = JSON.stringify(Object.fromEntries(Object.entries(tokens).map(([token, vault]) => [sha(token), vault])));
  const child: ChildProcess = spawn(
    process.execPath,
    [bin, "dev", "--port", String(WRANGLER_PORT), "--ip", "127.0.0.1", "--persist-to", state, "--var", `TOKENS:${table}`],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  await waitPort(WRANGLER_PORT, 90_000);
  return {
    dir,
    output: () => log,
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 500));
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
