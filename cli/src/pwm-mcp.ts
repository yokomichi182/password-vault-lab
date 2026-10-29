// pwm-mcp の入口(stdio)。標準出力は MCP の通信だけに使い、ログは標準エラーに出す。
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
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

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  serve(mcpCtx(), new StdioServerTransport()).catch(() => {
    process.stderr.write("pwm-mcp: failed to start\n");
    process.exitCode = 1;
  });
}
