import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BREACH_BASE_URL, restrictToBreachRange } from "../src/audit.ts";
import { windowsDpapi } from "../src/dpapi.ts";
import { FILES } from "../src/store.ts";
import { BreachTable, MockBreachServer, prefixOf, sha1Upper, suffixOf } from "./breachFixture.ts";
import { CANARY_AUTOM, CANARY_MAIN, MASTER, hasMarker, makeHome, makeKdbx, registerHomeScan, tmpHome, type TestItem } from "./helpers.ts";

registerHomeScan();

const ROOT = path.resolve(import.meta.dirname, "..");
const MCP_JS = path.join(ROOT, "dist", "pwm-mcp.mjs");

const PWNED = `${CANARY_AUTOM}-mcp-pwned`;
const PWNED2 = `${CANARY_AUTOM}-mcp-pwned-2`;
const CLEAN = `${CANARY_AUTOM}-mcp-clean`;
const APIKEY = `${CANARY_AUTOM}-mcp-apikey`;

const ITEMS: TestItem[] = [
  { title: "web-pwned", username: "alice", url: "https://web.example.test/", password: PWNED },
  { title: "web-pwned-2", password: PWNED2 },
  { title: "web-clean", password: CLEAN },
  { title: "svc", password: APIKEY, type: "apikey", environment: "prod" },
  { title: "empty", password: "" },
];

const table = new BreachTable();
table.addPwned(PWNED, 5000);
table.addPwned(PWNED2, 3);
const server = new MockBreachServer(table);
beforeAll(async () => void (await server.start()));
afterAll(() => server.stop());

const realHome = (items: TestItem[] = ITEMS) => makeHome(items, { protector: windowsDpapi });

async function connect(home: string, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_JS],
    env: { PWM_HOME: home, PWM_LANG: "en", PWM_BREACH_URL: server.url, ...env },
    stderr: "pipe",
  });
  const stderr: Buffer[] = [];
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  transport.stderr?.on("data", (d: Buffer) => stderr.push(d));
  return { client, stderr: () => Buffer.concat(stderr).toString("utf8"), close: () => client.close() };
}

type Text = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: unknown): string => (r as Text).content.map((c) => c.text).join("");

describe("10. MCP の audit", () => {
  it("ツールの一覧がちょうど5つ。audit は { pwned, clean, skipped, notApplicable } だけを返し、値・ハッシュ・ユーザー名・URL を返さない", async () => {
    const h = await realHome();
    server.requests = [];
    const m = await connect(h.dir);
    try {
      const tools = await m.client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["audit", "list_titles", "read_credential", "request_credential", "run"]);
      const audit = tools.tools.find((t) => t.name === "audit")!;
      // 手元の保管庫(前回の pwm sync の時点)についての結果であること、スキップは漏洩なしではないことを説明に書く
      expect(audit.description).toContain("last `pwm sync`");
      expect(audit.description).toContain("does NOT mean clean");
      expect(audit.inputSchema.properties ?? {}).toEqual({});

      const raw = textOf(await m.client.callTool({ name: "audit", arguments: {} }));
      const r = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(r).sort()).toEqual(["clean", "notApplicable", "pwned", "skipped"]);
      expect(r).toEqual({
        pwned: [
          { title: "web-pwned", count: 5000 },
          { title: "web-pwned-2", count: 3 },
        ],
        clean: 1,
        skipped: 0,
        notApplicable: 2, // API キーとパスワードが空の項目
      });
      for (const p of r.pwned as object[]) expect(Object.keys(p).sort()).toEqual(["count", "title"]);
      for (const secret of [PWNED, CLEAN, "alice", "web.example.test", sha1Upper(PWNED), suffixOf(PWNED).slice(0, 6), prefixOf(PWNED)]) {
        expect(raw.includes(secret), secret.slice(0, 6)).toBe(false);
      }
      // ログ(標準エラー)は件数まで
      expect(m.stderr()).toBe("pwm-mcp: audit done (pwned 2, clean 1, skipped 0, not applicable 2)\n");
      // モックに届いたのは、先頭5文字の要求だけ
      expect(server.requests.map((q) => q.path).sort()).toEqual([`/range/${prefixOf(PWNED)}`, `/range/${prefixOf(PWNED2)}`, `/range/${prefixOf(CLEAN)}`].sort());
      for (const q of server.requests) {
        expect(q.method).toBe("GET");
        expect(q.bodyLength).toBe(0);
        expect(q.headers["add-padding"]).toBe("true");
      }
    } finally {
      await m.close();
    }
  });

  it("モックサーバーが止まっているときは、全部スキップ(漏洩なしに数えない)", async () => {
    const h = await realHome();
    server.down = true;
    const m = await connect(h.dir);
    try {
      const r = JSON.parse(textOf(await m.client.callTool({ name: "audit", arguments: {} })));
      expect(r).toEqual({ pwned: [], clean: 0, skipped: 3, notApplicable: 2 });
    } finally {
      server.down = false;
      await m.close();
    }
  });

  it("PWM_BREACH_URL が誤りのときはエラーを返し、要求を送らない。文言に与えられた値を入れない", async () => {
    const h = await realHome();
    server.requests = [];
    const m = await connect(h.dir, { PWM_BREACH_URL: "https://example.com" });
    try {
      const r = (await m.client.callTool({ name: "audit", arguments: {} })) as Text;
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("PWM_BREACH_URL");
      expect(textOf(r).includes("example.com")).toBe(false);
      expect(server.requests).toHaveLength(0);
    } finally {
      await m.close();
    }
  });
});

describe("14. pwm-mcp の通信の制限(restrictToBreachRange)", () => {
  const BASES = [BREACH_BASE_URL, "http://127.0.0.1:8123", "http://localhost:8123"];

  it("基点の /range/<大文字16進5文字> への GET だけを通す。同期先の URL、別のホスト、PUT、本文付き、Request は、要求を出さずに失敗させる", async () => {
    for (const base of BASES) {
      let calls = 0;
      const inner: typeof fetch = async () => {
        calls += 1;
        return new Response("ok");
      };
      const f = restrictToBreachRange(base, inner);
      const good = `${base}/range/0A1F9`;
      await f(good);
      await f(good, { method: "GET", headers: { "Add-Padding": "true" } });
      await f(new URL(good));
      expect(calls).toBe(3);

      const other = base === BREACH_BASE_URL ? "http://127.0.0.1:8123" : BREACH_BASE_URL;
      const bad: [string, RequestInit | undefined][] = [
        ["https://example.com/range/0A1F9", undefined],
        [`${other}/range/0A1F9`, undefined],
        ["http://127.0.0.1:8787/vaults/automation", undefined], // 同期先(wrangler dev)
        ["https://sync.example.workers.dev/vaults/automation", undefined],
        [`${base}/vaults/main`, undefined],
        [`${base}/range/0A1F9`, { method: "PUT" }],
        [`${base}/range/0A1F9`, { method: "POST", body: "x" }],
        [`${base}/range/0A1F9`, { method: "GET", body: "x" }],
        [`${base}/range/0A1F9?x=1`, undefined],
        [`${base}/range/0A1F9#h`, undefined],
        [`${base}/range/0a1f9`, undefined],
        [`${base}/range/0A1F9A`, undefined],
        [`${base}/range/0A1F`, undefined],
        [`${base}/range/0A1F9/`, undefined],
        [`${base}/range/`, undefined],
        [`${base}/`, undefined],
        [`${base}.evil.example/range/0A1F9`, undefined],
        [`${base}@evil.example/range/0A1F9`, undefined],
        ["", undefined],
      ];
      for (const [url, init] of bad) {
        await expect(f(url, init), `${url} ${init?.method ?? ""}`).rejects.toThrow();
      }
      await expect(f(new Request(good))).rejects.toThrow(); // Request の形も通さない
      expect(calls).toBe(3); // 失敗した要求は inner に届いていない
      // 失敗の文言に URL を入れない
      const err = await f("https://example.com/range/0A1F9").catch((e: Error) => e.message);
      expect(String(err).includes("example.com")).toBe(false);
    }
  });
});

describe("16. MCP の audit が本体の保管庫を読まない", () => {
  it("PWM_HOME に本体のファイルだけがあるとき「自動処理用の保管庫がありません」。要求も送らない", async () => {
    const dir = await tmpHome();
    await writeFile(path.join(dir, "main.kdbx"), await makeKdbx({ master: MASTER }, [{ title: "main-pw", password: `${CANARY_MAIN}-1` }]));
    await writeFile(path.join(dir, "main.token.kdbx"), new Uint8Array([1, 2, 3]));
    await writeFile(path.join(dir, FILES.config), JSON.stringify({ syncUrl: "http://127.0.0.1:9", mainVault: "main" }));
    server.requests = [];
    const m = await connect(dir, { PWM_LANG: "ja" });
    try {
      const r = (await m.client.callTool({ name: "audit", arguments: {} })) as Text;
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("自動処理用の保管庫がありません");
      expect(server.requests).toHaveLength(0);
      expect(hasMarker(textOf(r) + m.stderr())).toBe(false);
    } finally {
      await m.close();
    }
  });

  it("自動処理用の保管庫と本体の保管庫が同じ PWM_HOME にあっても、本体の項目は結果に出ない", async () => {
    const h = await realHome([{ title: "auto-clean", password: CLEAN }]);
    const mainPwned = `${CANARY_MAIN}-main-only-pwned`;
    table.addPwned(mainPwned, 77);
    await writeFile(path.join(h.dir, "main.kdbx"), await makeKdbx({ master: MASTER }, [{ title: "main-only-title", password: mainPwned }]));
    server.requests = [];
    const m = await connect(h.dir);
    try {
      const raw = textOf(await m.client.callTool({ name: "audit", arguments: {} }));
      expect(JSON.parse(raw)).toEqual({ pwned: [], clean: 1, skipped: 0, notApplicable: 0 });
      expect(raw.includes("main-only-title")).toBe(false);
      expect(server.requests.some((q) => q.path === `/range/${prefixOf(mainPwned)}`)).toBe(false);
    } finally {
      await m.close();
    }
  });
});

/** MCP の通信の生の標準出力・標準エラーを集める(JSON-RPC を1行ずつ送る)。 */
class RawMcp {
  stdout = "";
  stderr = "";
  private id = 0;
  private waiters = new Map<number, (v: unknown) => void>();
  private child;
  constructor(home: string, env: Record<string, string>) {
    this.child = spawn(process.execPath, [MCP_JS], {
      env: { ...process.env, PWM_HOME: home, PWM_LANG: "en", ...env },
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
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async init(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => this.child.once("close", r));
  }
}

describe("17. カナリア(MCP の audit)", () => {
  it("audit の応答(生の標準出力の全体)と pwm-mcp の標準エラーに、目印もハッシュも出ない。PWM_HOME に新しいファイルができない", async () => {
    const h = await realHome();
    const before = (await readdir(h.dir)).sort();
    const texts: string[] = [];
    // 成功、通信できない、PWM_BREACH_URL の誤り、保管庫が無い
    for (const variant of ["ok", "down", "bad-url"] as const) {
      server.down = variant === "down";
      const raw = new RawMcp(h.dir, variant === "bad-url" ? { PWM_BREACH_URL: "https://example.com" } : {});
      await raw.init();
      await raw.request("tools/call", { name: "audit", arguments: {} });
      await raw.close();
      server.down = false;
      texts.push(raw.stdout, raw.stderr);
      for (const line of raw.stdout.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
    }
    const empty = await tmpHome();
    const raw2 = new RawMcp(empty, {});
    await raw2.init();
    await raw2.request("tools/call", { name: "audit", arguments: {} });
    await raw2.close();
    texts.push(raw2.stdout, raw2.stderr);

    for (const text of texts) {
      expect(hasMarker(text)).toBe(false);
      for (const pw of [PWNED, PWNED2, CLEAN]) {
        expect(text.includes(sha1Upper(pw))).toBe(false);
        expect(text.includes(suffixOf(pw).slice(0, 6))).toBe(false);
      }
      expect(text.includes("alice")).toBe(false);
      expect(text.includes("web.example.test")).toBe(false);
    }
    expect((await readdir(h.dir)).sort()).toEqual(before);
    // 保管庫の暗号文を直接見ても平文の目印は無い
    expect((await readFile(path.join(h.dir, FILES.automationKdbx))).includes(Buffer.from(CANARY_AUTOM))).toBe(false);
  });

  it("モックサーバーが受け取った要求(パス、ヘッダー、本文)に、目印も、ハッシュの6文字目以降も無い", async () => {
    const h = await realHome();
    server.requests = [];
    const m = await connect(h.dir);
    try {
      await m.client.callTool({ name: "audit", arguments: {} });
    } finally {
      await m.close();
    }
    expect(server.requests.length).toBeGreaterThan(0);
    const all = JSON.stringify(server.requests);
    expect(hasMarker(all)).toBe(false);
    for (const pw of [PWNED, PWNED2, CLEAN]) {
      expect(all.includes(pw)).toBe(false);
      expect(all.includes(suffixOf(pw).slice(0, 6))).toBe(false);
    }
    for (const q of server.requests) expect(q.path).toMatch(/^\/range\/[0-9A-F]{5}$/);
  });
});
