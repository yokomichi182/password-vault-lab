// pwm-mcp の入口(stdio)。標準出力は MCP の通信だけに使い、ログは標準エラーに出す。
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { windowsDpapi } from "./dpapi.ts";
import type { Ctx } from "./ctx.ts";
import { realSleep } from "./audit.ts";
import { detectLang } from "./i18n.ts";
import { serve } from "./mcpServer.ts";
import { pwmHome } from "./store.ts";

function mcpCtx(): Ctx {
  const environ = process.env as Record<string, string | undefined>;
  return {
    home: pwmHome(environ),
    lang: detectLang(environ),
    protector: windowsDpapi,
    // 通信しない。同期は pwm sync の役目(設計書 §11-2)
    fetch: () => Promise.reject(new Error("pwm-mcp does not use the network")),
    stdinIsTTY: false,
    prompt: { hidden: async () => null, line: async () => null },
    out: () => undefined, // 標準出力は MCP の通信だけ
    err: (c) => void process.stderr.write(c),
    environ,
    now: () => new Date(),
    sleep: realSleep,
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  serve(mcpCtx(), new StdioServerTransport()).catch(() => {
    process.stderr.write("pwm-mcp: failed to start\n");
    process.exitCode = 1;
  });
}
