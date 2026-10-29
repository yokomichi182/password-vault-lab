import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { windowsDpapi } from "../../src/dpapi.ts";
import { BreachTable, MockBreachServer, prefixOf, sha1Upper, suffixOf } from "../breachFixture.ts";
import { CANARY_AUTOM, filesContaining, hasMarker, makeHome, registerHomeScan } from "../helpers.ts";

// 4-2. 束ねた dist/pwm.mjs と dist/pwm-mcp.mjs を別のプロセスで動かし、ローカルのモックサーバー(127.0.0.1)で通す。
// 実在の Pwned Passwords API には送らない(どの起動にも PWM_BREACH_URL でモックを向ける)。
// ここで、Node の fetch が checkBreach の credentials/cache の設定を受け付けることを確かめる(受け付けないと全部「スキップ」になる)。
registerHomeScan();

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PWM_JS = path.join(ROOT, "dist", "pwm.mjs");
const MCP_JS = path.join(ROOT, "dist", "pwm-mcp.mjs");

const PWNED = `${CANARY_AUTOM}-it-audit-pwned`;
const CLEAN = `${CANARY_AUTOM}-it-audit-clean`;
const PADDED = `${CANARY_AUTOM}-it-audit-padded`; // 末尾が回数 0 の行(パディング)だけで返る
const APIKEY = `${CANARY_AUTOM}-it-audit-apikey`;

const table = new BreachTable();
table.addPwned(PWNED, 31337);
table.addPaddingFor(PADDED);

let server: MockBreachServer;
let home: string;
/** 出力の全体(カナリアの探査用) */
const captured: string[] = [];

beforeAll(async () => {
  server = new MockBreachServer(table);
  await server.start();
  const h = await makeHome(
    [
      { title: "it-pwned", username: "carol", url: "https://carol.example.test/", password: PWNED },
      { title: "it-clean", password: CLEAN },
      { title: "it-padded", password: PADDED },
      { title: "it-key", password: APIKEY, type: "apikey", environment: "test" },
    ],
    { protector: windowsDpapi },
  );
  home = h.dir;
});

afterAll(async () => {
  await server.stop();
});

function builtPwm(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [PWM_JS, ...args], {
      env: { ...process.env, PWM_HOME: home, PWM_LANG: "en", PWM_BREACH_URL: server.url, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => {
      captured.push(stdout, stderr);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe("4-2. 束ねた pwm audit をモックサーバーで通す", () => {
  it("漏洩済みの項目名と回数が出て終了コード 3。Node の fetch が設定を受け付ける(スキップ 0)。モックには先頭5文字と Add-Padding だけが届く", async () => {
    server.requests = [];
    const r = await builtPwm(["audit"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("Pwned:\n  it-pwned\t31337\nChecked: 3  Pwned: 1  Clean: 2  Skipped: 0  Not applicable: 1\n");
    expect(r.stderr).toBe("");
    // 回数 0 の行(パディング)は一致にならず、漏洩なしに数えられている
    expect(server.requests.map((q) => q.path).sort()).toEqual([PWNED, CLEAN, PADDED].map((p) => `/range/${prefixOf(p)}`).sort());
    // cache: "no-store" を受け付けた Node の fetch は、pragma と cache-control(どちらも no-cache)を足す。認証・Cookie は付かない
    const known = new Set(["host", "connection", "accept", "accept-language", "sec-fetch-mode", "user-agent", "accept-encoding", "add-padding", "pragma", "cache-control"]);
    for (const q of server.requests) {
      expect(q.method).toBe("GET");
      expect(q.bodyLength).toBe(0);
      expect(q.headers["add-padding"]).toBe("true");
      for (const name of Object.keys(q.headers)) expect(known.has(name), name).toBe(true);
    }
    // モックの記録に、パスワード・ハッシュの全体・目印が無い
    const all = JSON.stringify(server.requests);
    expect(hasMarker(all)).toBe(false);
    for (const pw of [PWNED, CLEAN, PADDED, APIKEY]) {
      expect(all.includes(pw)).toBe(false);
      expect(all.includes(sha1Upper(pw))).toBe(false);
      expect(all.includes(suffixOf(pw).slice(0, 6))).toBe(false);
    }
    // 出力にも出ない
    for (const text of [r.stdout, r.stderr]) {
      expect(text.includes("carol") || text.includes("carol.example.test")).toBe(false);
      expect(text.includes(sha1Upper(PWNED))).toBe(false);
    }
  });

  it("日本語の出力も同じ形。PWM_BREACH_URL が誤りのときは終了コード 1 で、要求を送らない", async () => {
    const ja = await builtPwm(["audit"], { PWM_LANG: "ja" });
    expect(ja.code).toBe(3);
    expect(ja.stdout).toBe("漏洩済み:\n  it-pwned\t31337\n確認: 3  漏洩済み: 1  漏洩なし: 2  スキップ: 0  対象外: 1\n");
    server.requests = [];
    for (const bad of ["https://example.com", "http://192.168.0.1:80", "http://127.0.0.1:1/x"]) {
      const r = await builtPwm(["audit"], { PWM_BREACH_URL: bad });
      expect(r.code, bad).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("PWM_BREACH_URL");
      expect(r.stderr.includes(bad)).toBe(false);
    }
    expect(server.requests).toHaveLength(0);
  });

  it("--main は端末でないと何もしない(終了コード 1、要求を送らない)", async () => {
    server.requests = [];
    const r = await builtPwm(["audit", "--main"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(server.requests).toHaveLength(0);
  });

  it("束ねた pwm-mcp の audit(SDK のクライアント)も同じ結果を返し、値・ハッシュを返さない", async () => {
    server.requests = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_JS],
      env: { PWM_HOME: home, PWM_LANG: "en", PWM_BREACH_URL: server.url },
      stderr: "pipe",
    });
    const stderr: Buffer[] = [];
    const client = new Client({ name: "it", version: "0" });
    await client.connect(transport);
    transport.stderr?.on("data", (d: Buffer) => stderr.push(d));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["audit", "list_titles", "read_credential", "run"]);
      const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("");
      const raw = text(await client.callTool({ name: "audit", arguments: {} }));
      expect(JSON.parse(raw)).toEqual({ pwned: [{ title: "it-pwned", count: 31337 }], clean: 2, skipped: 0, notApplicable: 1 });
      captured.push(raw);
      for (const pw of [PWNED, CLEAN, PADDED]) expect(raw.includes(sha1Upper(pw)) || raw.includes(pw)).toBe(false);
      // pwm-mcp の同期先への通信は無い: 届いたのはモックの /range/ だけ
      expect(server.requests.every((q) => /^\/range\/[0-9A-F]{5}$/.test(q.path))).toBe(true);
      expect(server.requests).toHaveLength(3);
    } finally {
      await client.close();
    }
    captured.push(Buffer.concat(stderr).toString("utf8"));
  });

  it("モックを止めると、pwm audit は全部スキップで終了コード 2、MCP の audit も全部スキップ(漏洩なしに数えない)", async () => {
    await server.stop();
    const r = await builtPwm(["audit"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe(
      [
        "Checked: 3  Pwned: 0  Clean: 0  Skipped: 3  Not applicable: 1",
        "Skipped items could not be checked (offline or no usable response). They are not confirmed clean.",
        "",
      ].join("\n"),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_JS],
      env: { PWM_HOME: home, PWM_LANG: "en", PWM_BREACH_URL: server.url },
      stderr: "pipe",
    });
    const client = new Client({ name: "it", version: "0" });
    await client.connect(transport);
    try {
      const raw = (await client.callTool({ name: "audit", arguments: {} })) as { content: { text: string }[] };
      const text = raw.content.map((c) => c.text).join("");
      expect(JSON.parse(text)).toEqual({ pwned: [], clean: 0, skipped: 3, notApplicable: 1 });
      captured.push(text);
    } finally {
      await client.close();
    }
  });

  it("カナリア: 出力の全体、モックの記録、PWM_HOME の全ファイルに目印が無い。監査で新しいファイルができない", async () => {
    for (const text of captured) expect(hasMarker(text)).toBe(false);
    expect(await filesContaining(home)).toEqual([]);
    expect((await readdir(home)).sort()).toEqual(["automation.kdbx", "automation.key.dpapi"]);
  });
});
