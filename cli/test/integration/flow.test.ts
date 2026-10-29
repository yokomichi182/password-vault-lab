import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { windowsDpapi } from "../../src/dpapi.ts";
import { runPwm } from "../../src/pwm.ts";
import { CONCEALED } from "../../src/run.ts";
import { FILES } from "../../src/store.ts";
import { CANARY_AUTOM, CANARY_MAIN, MASTER, filesContaining, hasMarker, makeCtx, makeKdbx, tmpHome } from "../helpers.ts";
import { SYNC_URL, startWrangler, type Wrangler } from "./wrangler.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PWM_JS = path.join(ROOT, "dist", "pwm.mjs");
const MCP_JS = path.join(ROOT, "dist", "pwm-mcp.mjs");
const CHILD = path.join(import.meta.dirname, "..", "child.cjs");

// 架空のトークン
const TOKEN_AUTO = `${CANARY_AUTOM}-it-token-auto`;
const TOKEN_MAIN = `${CANARY_MAIN}-it-token-main`;
const PASSWORD_VALUE = `${CANARY_AUTOM}-it-password`;
const APIKEY_VALUE = `${CANARY_AUTOM}-it-apikey`;
const MAIN_VALUE = `${CANARY_MAIN}-it-main-pw`;

let wrangler: Wrangler;
let home: string;
/** pwm と pwm-mcp の標準出力・標準エラー(カナリアの探査用。read と run の値の出力そのものは除く) */
const captured: string[] = [];

beforeAll(async () => {
  wrangler = await startWrangler({ [TOKEN_AUTO]: "automation", [TOKEN_MAIN]: "main" });
  home = await tmpHome();
}, 240_000);

afterAll(async () => {
  await wrangler?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

/** 入力を差し替えた同じプロセスで動かす(本物の DPAPI と本物の同期先)。 */
async function interactive(argv: string[], answers: string[], captureOut = true) {
  // 保存のあとの漏洩チェックの先は、何も待ち受けていないローカルのポート(実 API には送らない)
  const environ = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PWM_BREACH_URL: "http://127.0.0.1:9" };
  const t = makeCtx(home, { protector: windowsDpapi, fetchImpl: fetch, answers, environ });
  const code = await runPwm(argv, t.ctx);
  captured.push(captureOut ? t.stdout() : "", t.stderr());
  return { code, out: t.stdout(), err: t.stderr() };
}

/** 作った dist/pwm.mjs を別のプロセスで動かす(標準入力は端末でない)。 */
function builtPwm(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PWM_JS, ...args], { env: { ...process.env, PWM_HOME: home, PWM_LANG: "en", PWM_BREACH_URL: "http://127.0.0.1:9" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe("4-2. 実際の wrangler dev を同期先にした通し", () => {
  it("auto init → auto add(パスワードと API キー)→ sync → read → run", async () => {
    const init = await interactive(["auto", "init", "--sync-url", SYNC_URL], [TOKEN_AUTO]);
    expect(init.code).toBe(0);
    const addPw = await interactive(["auto", "add", "--title", "it-site", "--username", "carol"], [PASSWORD_VALUE, PASSWORD_VALUE]);
    expect(addPw.code).toBe(0);
    const addKey = await interactive(
      ["auto", "add", "--title", "it-key", "--type", "apikey", "--env", "test", "--expires", "2031-12-31"],
      [APIKEY_VALUE, APIKEY_VALUE],
    );
    expect(addKey.code).toBe(0);

    // 別の PWM_HOME を使わずに pwm sync(別プロセスの本物の dist)
    const sync = await builtPwm(["sync"]);
    captured.push(sync.stdout, sync.stderr);
    expect(sync.code).toBe(0);

    const list = await builtPwm(["auto", "list"]);
    captured.push(list.stdout, list.stderr);
    expect(list.stdout.split("\n").filter(Boolean).sort()).toEqual(["it-key\tapikey\ttest", "it-site\tpassword\t"]);

    const read = await builtPwm(["read", "it-site"]);
    expect(read).toMatchObject({ code: 0, stdout: `${PASSWORD_VALUE}\n` });
    expect((await builtPwm(["read", "it-site/username"])).stdout).toBe("carol\n");
    expect((await builtPwm(["read", "it-key/type"])).stdout).toBe("apikey\n");
    expect((await builtPwm(["read", "it-key/expires"])).stdout).toBe("2031-12-31\n");

    const check = await builtPwm(["run", "--env", "K=it-key", "--", process.execPath, CHILD, "check", "K", APIKEY_VALUE]);
    expect(check).toMatchObject({ code: 0, stdout: "match" });
    const echo = await builtPwm(["run", "--env", "K=it-key", "--", process.execPath, CHILD, "echo", "K"]);
    captured.push(echo.stdout, echo.stderr);
    expect(echo.stdout).toBe(`out:${CONCEALED}:end\n`);
    expect(echo.stderr).toBe(`err:${CONCEALED}:end\n`);
    expect(echo.code).toBe(0);
  });

  it("pwm-mcp の read_credential と run(同期した自動処理用の保管庫を読む)", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_JS], env: { PWM_HOME: home, PWM_LANG: "en" }, stderr: "pipe" });
    const stderr: Buffer[] = [];
    const client = new Client({ name: "it", version: "0" });
    await client.connect(transport);
    transport.stderr?.on("data", (d: Buffer) => stderr.push(d));
    try {
      const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("");
      const cred = JSON.parse(text(await client.callTool({ name: "read_credential", arguments: { title: "it-key" } })));
      expect(cred).toMatchObject({ password: APIKEY_VALUE, type: "apikey", environment: "test", expires: "2031-12-31" });
      const ran = JSON.parse(
        text(await client.callTool({ name: "run", arguments: { command: [process.execPath, CHILD, "echo", "K"], env: { K: "it-key" } } })),
      );
      expect(ran).toMatchObject({ exit_code: 0, stdout: `out:${CONCEALED}:end\n`, stderr: `err:${CONCEALED}:end\n` });
      captured.push(JSON.stringify(ran), Buffer.concat(stderr).toString("utf8"));
      // 本体の保管庫のタイトルは見えない
      const titles = text(await client.callTool({ name: "list_titles", arguments: {} }));
      expect(titles).not.toContain("main-site");
    } finally {
      await client.close();
    }
    captured.push(Buffer.concat(stderr).toString("utf8"));
  });

  it("本体の保管庫を kdbxweb で作って main に PUT し、pwm main setup → pwm read --main", async () => {
    const bytes = await makeKdbx({ master: MASTER }, [{ title: "main-site", username: "dave", password: MAIN_VALUE }]);
    const put = await fetch(`${SYNC_URL}/vaults/main`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN_MAIN}`, "If-Match": "0", "X-Device-Name": "it" },
      body: Buffer.from(bytes),
    });
    expect(put.status).toBe(200);

    const setup = await interactive(["main", "setup", "--sync-url", SYNC_URL], [TOKEN_MAIN, MASTER]);
    expect(setup.code).toBe(0);
    const read = await interactive(["read", "--main", "main-site/password"], [MASTER], false);
    expect(read).toMatchObject({ code: 0, out: `${MAIN_VALUE}\n` });
    // --main なしでは、本体の項目は見えない
    const noMain = await builtPwm(["read", "main-site"]);
    expect(noMain.code).not.toBe(0);
    captured.push(noMain.stdout, noMain.stderr);
    // 両方の保管庫が同じ PWM_HOME にあっても、自動処理用の項目は --main で見えない
    const other = await interactive(["read", "--main", "it-site"], [MASTER]);
    expect(other.code).not.toBe(0);
  });

  it("トークンの分離: 自動処理用のトークンで main を GET すると 403、本体のトークンで automation を GET すると 403", async () => {
    const get = (vault: string, token: string) => fetch(`${SYNC_URL}/vaults/${vault}`, { headers: { Authorization: `Bearer ${token}` } }).then(async (r) => {
      await r.arrayBuffer();
      return r.status;
    });
    expect(await get("main", TOKEN_AUTO)).toBe(403);
    expect(await get("automation", TOKEN_MAIN)).toBe(403);
    expect(await get("automation", TOKEN_AUTO)).toBe(200);
    expect(await get("main", TOKEN_MAIN)).toBe(200);
    // CLI の設定が取り違えていない: 自動処理用の設定は automation、本体用は main
    const cfg = JSON.parse(await readFile(path.join(home, FILES.config), "utf8")) as Record<string, string>;
    expect(cfg.automationVault).toBe("automation");
    expect(cfg.mainVault).toBe("main");
  });

  it("カナリア: pwm と pwm-mcp の出力、wrangler dev の出力、PWM_HOME の全ファイルに目印が無い", async () => {
    for (const text of captured) expect(hasMarker(text)).toBe(false);
    expect(hasMarker(wrangler.output())).toBe(false);
    expect(await filesContaining(home)).toEqual([]);
  });
});
