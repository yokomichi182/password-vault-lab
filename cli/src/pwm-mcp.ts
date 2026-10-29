// pwm-mcp の入口(stdio)。標準出力は MCP の通信だけに使い、ログは標準エラーに出す。
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { windowsDpapi } from "./dpapi.ts";
import type { Ctx } from "./ctx.ts";
import { BREACH_BASE_URL, realSleep, resolveBreachBase, restrictToBreachRange } from "./audit.ts";
import { detectLang } from "./i18n.ts";
import { serve } from "./mcpServer.ts";
import { pwmHome } from "./store.ts";

/**
 * 通信を許す先の基点。PWM_BREACH_URL が誤りのときは、本番の基点に制限する(audit のツールは誤りをエラーで返し、要求を出さない)。
 */
function breachBase(environ: Record<string, string | undefined>): string {
  try {
    return resolveBreachBase(environ);
  } catch {
    return BREACH_BASE_URL;
  }
}

function mcpCtx(): Ctx {
  const environ = process.env as Record<string, string | undefined>;
  return {
    home: pwmHome(environ),
    lang: detectLang(environ),
    protector: windowsDpapi,
    // 通信してよいのは、HIBP の基点の /range/<5文字> への GET だけ(audit のため)。同期先(Cloudflare)には触れない。
    // 同期は pwm sync の役目(設計書 §11-2)。それ以外の URL・メソッドは、要求を出さずに失敗させる
    fetch: restrictToBreachRange(breachBase(environ), globalThis.fetch),
    stdinIsTTY: false,
    prompt: { hidden: async () => null, line: async () => null },
    out: () => undefined, // 標準出力は MCP の通信だけ
    err: (c) => void process.stderr.write(c),
    environ,
    now: () => new Date(),
    sleep: realSleep,
    notify: () => Promise.reject(new Error("pwm-mcp does not show notifications")),
  };
}

/** 承認ダイアログを出す子のプロセス(同じ dist の pwm.mjs approve-credential)を動かして、標準出力を返す。標準エラーは捨てる。 */
const APPROVE_WAIT_MS = 150_000;
function spawnApprove(args: { title: string; client: string }): Promise<string> {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "pwm.mjs");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [script, "approve-credential", "--title", args.title, "--client", args.client], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (d: Buffer) => {
      if (size < 64 * 1024) {
        chunks.push(d);
        size += d.length;
      }
    });
    const timer = setTimeout(() => child.kill(), APPROVE_WAIT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  serve(mcpCtx(), new StdioServerTransport(), { approve: spawnApprove }).catch(() => {
    process.stderr.write("pwm-mcp: failed to start\n");
    process.exitCode = 1;
  });
}
