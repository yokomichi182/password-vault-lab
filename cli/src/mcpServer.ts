// MCP サーバーの本体(stdio)。読むのは自動処理用の保管庫だけ。ネットワークの待ち受けを開かず、Cloudflare に触れない。
// 通信するのは audit だけで、ctx.fetch が許す HIBP の範囲の API(/range/<5文字>)への GET に限る(フェーズ3.6、入口の pwm-mcp.ts で制限する)。
// 本体の保管庫に関するモジュール(src/main/、commands/)は import しない(設計書 §11-2、AGENTS.md の決まり7)。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { errorLabel } from "../../extension/src/shared/vault.ts";
import { parseApproveOutput, sanitizeClientName, toToolPayload, type ApproveOutcome } from "./approve/protocol.ts";
import { auditDeps, auditVault } from "./audit.ts";
import { withAutomationDb } from "./automation.ts";
import { CliError, type Ctx } from "./ctx.ts";
import { fieldText, findOne, liveEntries, parseRef, resolveRef, toCredential } from "./kdbx.ts";
import { msg } from "./i18n.ts";
import { ENV_NAME_RE, runChild } from "./run.ts";

export const OUTPUT_LIMIT = 64 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 600;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** 先頭の limit バイトまで集める。超えたら切ったことを覚える。 */
class Capture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  push(b: Buffer): void {
    const room = OUTPUT_LIMIT - this.size;
    if (room <= 0) {
      if (b.length > 0) this.truncated = true;
      return;
    }
    const part = b.length > room ? b.subarray(0, room) : b;
    if (b.length > room) this.truncated = true;
    this.chunks.push(Buffer.from(part));
    this.size += part.length;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** MCP サーバーの外とのつながり(入口で本物を渡し、テストでは差し替える)。 */
export interface McpDeps {
  /** 承認ダイアログの子のプロセス(pwm.mjs approve-credential)を動かし、標準出力の全体を返す。無いときは unavailable */
  approve?: (args: { title: string; client: string }) => Promise<string>;
}

export function createServer(ctx: Ctx, deps: McpDeps = {}): McpServer {
  const server = new McpServer({ name: "pwm-mcp", version: "0.1.0" });
  /** 同時に出すダイアログは1つまで */
  let approving = false;

  /** 例外を、値を含まない応答にする。標準エラーには例外の型の名前までを出す。 */
  const guarded = (tool: string, fn: () => Promise<ToolResult>): Promise<ToolResult> =>
    fn().catch((e: unknown) => {
      if (e instanceof CliError) {
        ctx.err(`pwm-mcp: ${tool} failed (${e.key})\n`);
        return fail(e.text(ctx.lang));
      }
      const label = errorLabel(e);
      ctx.err(`pwm-mcp: ${tool} failed (${label})\n`);
      return fail(msg(ctx.lang, "mcpToolError", { label }));
    });

  server.registerTool(
    "list_titles",
    {
      description:
        "List the items in the automation vault: title, type (password or apikey) and environment. Never returns values, user names or URLs.",
      inputSchema: {},
    },
    () =>
      guarded("list_titles", () =>
        withAutomationDb(ctx, (db) =>
          ok(
            liveEntries(db).map((e) => {
              const c = toCredential(e);
              return { title: c.title, type: c.type, environment: c.environment };
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "read_credential",
    {
      description:
        "Read one item of the automation vault by exact title: username, password, url, notes, type, environment, expires. " +
        "WARNING: the returned secret stays in this conversation's record. For API keys and anything that can be passed " +
        "as an environment variable, prefer the `run` tool so the value never appears in the conversation.",
      inputSchema: { title: z.string().describe("Exact title of the item") },
    },
    ({ title }) =>
      guarded("read_credential", () =>
        withAutomationDb(ctx, (db) => {
          const c = toCredential(findOne(db, title));
          return ok({
            username: c.username,
            password: c.password,
            url: c.url,
            notes: c.notes,
            type: c.type,
            environment: c.environment,
            expires: c.expires,
          });
        }),
      ),
  );

  server.registerTool(
    "run",
    {
      description:
        "Run a command with secrets from the automation vault passed as environment variables, without the shell. " +
        "`env` maps a variable name to a reference \"TITLE/FIELD\" (FIELD is password by default; also username, url, notes, type, environment, expires). " +
        "Use this instead of read_credential for API keys: the secret values are replaced with <concealed by pwm> in the output, " +
        "so they do not enter the conversation. Values transformed by the command (base64, reversed, partial) cannot be concealed. " +
        `Output is limited to the first ${OUTPUT_LIMIT / 1024} KiB of stdout and of stderr. timeout_seconds defaults to ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}.`,
      inputSchema: {
        command: z.array(z.string()).describe("Program followed by its arguments"),
        env: z.record(z.string(), z.string()).optional().describe("Variable name to \"TITLE/FIELD\""),
        timeout_seconds: z.number().optional(),
      },
    },
    ({ command, env, timeout_seconds }) =>
      guarded("run", async () => {
        if (command.length === 0 || command[0] === "") return fail(msg(ctx.lang, "mcpBadCommand"));
        const timeoutSec = timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > MAX_TIMEOUT_SECONDS) {
          return fail(msg(ctx.lang, "mcpBadTimeout", { max: MAX_TIMEOUT_SECONDS }));
        }
        const specs = Object.entries(env ?? {});
        const baseLower = new Set(Object.keys(ctx.environ).map((k) => k.toLowerCase()));
        for (const [name, ref] of specs) {
          if (!ENV_NAME_RE.test(name)) throw new CliError("badEnvSpec");
          if (baseLower.has(name.toLowerCase())) throw new CliError("envExists");
          parseRef(ref);
        }
        const resolved = await withAutomationDb(ctx, (db) => specs.map(([name, ref]) => ({ name, value: resolveRef(db, ref) })));
        const extraEnv: Record<string, string> = {};
        for (const r of resolved) extraEnv[r.name] = r.value;
        const out = new Capture();
        const err = new Capture();
        const exitCode = await runChild({
          command,
          extraEnv,
          baseEnv: ctx.environ,
          values: resolved.map((r) => r.value),
          timeoutMs: timeoutSec * 1000,
          stdin: "ignore",
          onStdout: (b) => out.push(b),
          onStderr: (b) => err.push(b),
        });
        return ok({
          exit_code: exitCode,
          stdout: out.text(),
          stderr: err.text(),
          stdout_truncated: out.truncated,
          stderr_truncated: err.truncated,
        });
      }),
  );

  server.registerTool(
    "audit",
    {
      description:
        "Check the passwords in the automation vault against known breaches (Have I Been Pwned, k-anonymity: only the first 5 characters of each SHA-1 hash are sent). " +
        "Returns the titles and occurrence counts of breached items, and the counts of clean, skipped and not-applicable items. " +
        "Never returns passwords, hashes, user names or URLs. " +
        "The result is about the local copy of the vault as of the last `pwm sync`, not about the server. " +
        "'skipped' means the item could not be checked (offline or no usable response); it does NOT mean clean. " +
        "API keys and unknown item types are not applicable and are not sent. " +
        "Takes tens of seconds for hundreds of items (requests are spaced by 200 ms).",
      inputSchema: {},
    },
    () =>
      guarded("audit", async () => {
        const deps = auditDeps(ctx);
        const r = await withAutomationDb(ctx, (db) => auditVault(db, deps));
        ctx.err(`pwm-mcp: audit done (pwned ${r.pwned.length}, clean ${r.clean}, skipped ${r.skipped}, not applicable ${r.notApplicable})\n`);
        return ok({ pwned: r.pwned, clean: r.clean, skipped: r.skipped, notApplicable: r.notApplicable });
      }),
  );

  server.registerTool(
    "request_credential",
    {
      description:
        "Ask the person at the PC to approve handing you ONE item from their MAIN vault. Use it only when the item is not in the automation vault " +
        "(if it is, this tool refuses and tells you to use read_credential). A dialog appears on the PC asking for their master password and approval; " +
        "they can return the value once, or copy it into the automation vault and then return it. " +
        "Returns the same fields as read_credential plus returnedOnce and copied (and copyFailure / breach when relevant), or {\"result\": \"denied\" | \"not_found\" | \"busy\" | \"unavailable\"} with no value. " +
        "'denied' covers refusal, timeout (120 s), closing the dialog and a wrong master password; do not retry in a loop. " +
        "WARNING: a returned secret stays in this conversation's record.",
      inputSchema: { title: z.string().describe("Exact title of the item in the main vault") },
    },
    ({ title }) =>
      guarded("request_credential", async () => {
        if (title === "") return fail(msg(ctx.lang, "badTitle"));
        if (approving) {
          ctx.err("pwm-mcp: request_credential busy\n");
          return ok({ result: "busy" });
        }
        approving = true;
        try {
          // 自動処理用の保管庫に同じ項目名があれば、ダイアログを出さずに read_credential を勧める
          const inAutomation = await withAutomationDb(ctx, (db) => liveEntries(db).some((e) => fieldText(e.fields.get("Title")) === title)).catch(
            (e: unknown) => {
              if (e instanceof CliError && e.key === "noAutomation") return false;
              throw e;
            },
          );
          if (inAutomation) return fail(msg(ctx.lang, "mcpUseReadCredential"));

          const client = sanitizeClientName(server.server.getClientVersion()?.name);
          let outcome: ApproveOutcome;
          try {
            outcome = deps.approve ? parseApproveOutput(await deps.approve({ title, client })) : { result: "unavailable" };
          } catch {
            outcome = { result: "unavailable" };
          }
          ctx.err(`pwm-mcp: request_credential ${outcome.result}\n`); // 結果の種類だけ。項目名と値は出さない
          return ok(toToolPayload(outcome));
        } finally {
          approving = false;
        }
      }),
  );

  return server;
}

export async function serve(ctx: Ctx, transport: Transport, deps: McpDeps = {}): Promise<McpServer> {
  const server = createServer(ctx, deps);
  await server.connect(transport);
  return server;
}
