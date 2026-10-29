import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { windowsDpapi } from "../src/dpapi.ts";
import { FILES } from "../src/store.ts";
import { BreachTable, MockBreachServer } from "./breachFixture.ts";
import { MockSync } from "./mockSync.ts";
import { makeWorld } from "./approveFixture.ts";
import { CANARY_AUTOM, CANARY_MAIN, MASTER, hasMarker, registerHomeScan } from "./helpers.ts";

registerHomeScan();

// 4-3: MCP クライアントのエミュレーション(経路 A)。テスト用のビルド(dist/test/)の pwm-mcp を標準入出力で動かし、
// initialize、tools/list、tools/call を送る。承認ダイアログは台本のファイル(PWM_TEST_DIALOG_FILE)に差し替える(テスト用のビルドだけで効く)。
// 自動処理用の保管庫は本物の DPAPI で守る。
const ROOT = path.resolve(import.meta.dirname, "..");
const MCP_TEST_JS = path.join(ROOT, "dist", "test", "pwm-mcp.mjs");

const PW_MAIN = `${CANARY_MAIN}-emu-main-pw`;
const KEY_MAIN = `${CANARY_MAIN}-emu-main-key`;
const PW_AUTO = `${CANARY_AUTOM}-emu-auto-pw`;
const PWNED_AUTO = `${CANARY_AUTOM}-emu-auto-pwned`;

const MAIN_ITEMS = [
  { title: "Main Site", username: "alice-main", password: PW_MAIN, url: "https://main.example.test/" },
  { title: "Main Key", username: "key-id", password: KEY_MAIN, type: "apikey", environment: "live" },
];
const AUTO_ITEMS = [
  { title: "auto-web", username: "bot", password: PW_AUTO, url: "https://auto.example.test/" },
  { title: "auto-pwned", username: "bot2", password: PWNED_AUTO },
  { title: "auto-key", password: `${CANARY_AUTOM}-emu-key`, type: "apikey" },
];

const mock = new MockSync();
const table = new BreachTable();
table.addPwned(PWNED_AUTO, 4242);
table.addPwned(PW_MAIN, 99);
const breach = new MockBreachServer(table);
const scriptDir: { dir: string } = { dir: "" };
beforeAll(async () => {
  await mock.start();
  await breach.start();
  scriptDir.dir = await mkdtemp(path.join(os.tmpdir(), "pwm-emu-script-")); // 台本は PWM_HOME の外(マスターパスワードの目印を含むので、探査の対象にしない)
});
afterAll(async () => {
  await mock.stop();
  await breach.stop();
  await rm(scriptDir.dir, { recursive: true, force: true }).catch(() => undefined);
});

type Text = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: unknown): string => (r as Text).content.map((c) => c.text).join("");

let n = 0;
async function setup(clientName = "emulated-ai") {
  const w = await makeWorld(mock, MAIN_ITEMS, AUTO_ITEMS, { protector: windowsDpapi });
  const scriptFile = path.join(scriptDir.dir, `script-${++n}.json`);
  const setScript = (spec: Record<string, unknown>) => writeFile(scriptFile, JSON.stringify(spec));
  await setScript({});
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_TEST_JS],
      env: { PWM_HOME: w.home.dir, PWM_LANG: "en", PWM_BREACH_URL: breach.url, PWM_TEST_DIALOG_FILE: scriptFile },
      stderr: "pipe",
    });
    const stderr: Buffer[] = [];
    const client = new Client({ name: clientName, version: "0" });
    await client.connect(transport); // initialize
    transport.stderr?.on("data", (d: Buffer) => stderr.push(d));
    return { client, stderr: () => Buffer.concat(stderr).toString("utf8"), close: () => client.close() };
  };
  const seen = async () => JSON.parse(await readFile(scriptFile + ".seen", "utf8").catch(() => "null")) as Record<string, unknown> | null;
  const autoBytes = () => readFile(path.join(w.home.dir, FILES.automationKdbx));
  const puts = () => mock.requests.filter((r) => r.method === "PUT").length;
  return { w, setScript, connect, seen, autoBytes, puts, scriptFile };
}

describe("経路 A: MCP クライアントのエミュレーション(実際のプロセス)", () => {
  it("tools/list は6つ。read_credential は自動処理用の保管庫の値を返し、本体の保管庫の項目名(パスワードと API キーの両方)は該当なし", async () => {
    const s = await setup();
    const m = await s.connect();
    try {
      const tools = await m.client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["audit", "list_titles", "read_credential", "request_credential", "request_fill", "run"]);
      const ok = JSON.parse(textOf(await m.client.callTool({ name: "read_credential", arguments: { title: "auto-web" } })));
      expect(ok).toMatchObject({ username: "bot", password: PW_AUTO, url: "https://auto.example.test/", type: "password" });
      for (const title of ["Main Site", "Main Key"]) {
        const r = (await m.client.callTool({ name: "read_credential", arguments: { title } })) as Text;
        expect(r.isError, title).toBe(true);
        expect(textOf(r), title).toBe("No matching item.");
        expect(hasMarker(textOf(r))).toBe(false);
      }
      const titles = textOf(await m.client.callTool({ name: "list_titles", arguments: {} }));
      expect(titles).not.toContain("Main");
    } finally {
      await m.close();
    }
  });

  it("request_credential: 拒否したら値を返さない(denied)。ダイアログに見せた内容は、項目名・AI の名前(initialize の clientInfo)・時刻。自動処理用の保管庫は変わらない", async () => {
    const s = await setup("emulated-ai");
    const m = await s.connect();
    try {
      const before = await s.autoBytes();
      const puts = s.puts();
      await s.setScript({}); // 1段目で拒否
      const r = textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } }));
      expect(JSON.parse(r)).toEqual({ result: "denied" });
      expect(r.includes(PW_MAIN)).toBe(false);
      const seen = await s.seen();
      expect(seen).toMatchObject({ request: { title: "Main Site", client: "emulated-ai" }, choice: "deny" });
      // 2段目で拒否
      await s.setScript({ master: MASTER, choice: "deny" });
      expect(JSON.parse(textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } })))).toEqual({ result: "denied" });
      // マスターパスワードの誤り
      await s.setScript({ master: "wrong-master", choice: "once" });
      const wrong = textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } }));
      expect(JSON.parse(wrong)).toEqual({ result: "denied" });
      expect(Buffer.from(await s.autoBytes()).equals(Buffer.from(before))).toBe(true);
      expect(s.puts()).toBe(puts);
      expect(m.stderr()).toContain("pwm-mcp: request_credential denied");
      expect(m.stderr()).not.toContain("Main Site");
      expect(hasMarker(m.stderr())).toBe(false);
    } finally {
      await m.close();
    }
  });

  it("request_credential: 「今回だけ」は値を返し(returnedOnce)、自動処理用の保管庫には書かれない。あとから read_credential で読めない。項目が無ければ not_found", async () => {
    const s = await setup();
    const m = await s.connect();
    try {
      const before = await s.autoBytes();
      const puts = s.puts();
      await s.setScript({ master: MASTER, choice: "once" });
      const r = JSON.parse(textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } })));
      expect(r).toEqual({ username: "alice-main", password: PW_MAIN, url: "https://main.example.test/", notes: "", type: "password", environment: "", expires: "", returnedOnce: true, copied: false });
      const key = JSON.parse(textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "Main Key" } })));
      expect(key).toMatchObject({ password: KEY_MAIN, type: "apikey", environment: "live", returnedOnce: true, copied: false });
      expect(Buffer.from(await s.autoBytes()).equals(Buffer.from(before))).toBe(true);
      expect(s.puts()).toBe(puts);
      const later = (await m.client.callTool({ name: "read_credential", arguments: { title: "Main Site" } })) as Text;
      expect(later.isError).toBe(true);
      const none = JSON.parse(textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "No Such Item" } })));
      expect(none).toEqual({ result: "not_found" });
      expect(hasMarker(m.stderr())).toBe(false);
      expect(m.stderr()).not.toContain("Main Site");
    } finally {
      await m.close();
    }
  });

  it("request_credential: 「複製してから返す」は値を返し(copied)、自動処理用の保管庫に増える。以後は承認なしの read_credential で読め、request_credential は read_credential を勧める(ダイアログなし)", async () => {
    const s = await setup();
    const m = await s.connect();
    try {
      const puts = s.puts();
      await s.setScript({ master: MASTER, choice: "copy" });
      const r = JSON.parse(textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } })));
      expect(r).toMatchObject({ password: PW_MAIN, returnedOnce: false, copied: true, breach: { status: "pwned", count: 99 } });
      expect(s.puts()).toBe(puts + 1);
      // 同期先とのつながりがなくても、手元の写しで読める
      const again = JSON.parse(textOf(await m.client.callTool({ name: "read_credential", arguments: { title: "Main Site" } })));
      expect(again).toMatchObject({ username: "alice-main", password: PW_MAIN });
      // ダイアログを出さない(台本の記録を消してから確かめる)
      await rm(s.scriptFile + ".seen", { force: true });
      const dup = (await m.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } })) as Text;
      expect(dup.isError).toBe(true);
      expect(textOf(dup)).toContain("read_credential");
      expect(await s.seen()).toBeNull();
      // 漏洩チェックの要求は、先頭5文字だけ(モックの記録)
      for (const q of breach.requests) expect(q.path).toMatch(/^\/range\/[0-9A-F]{5}$/);
      expect(hasMarker(m.stderr())).toBe(false);
    } finally {
      await m.close();
    }
  });

  it("request_credential: 同期先とつながらないときは unavailable(値を返さない)。複製に失敗したときは、値を今回だけ返して copied: false", async () => {
    const s = await setup();
    const m = await s.connect();
    try {
      await s.setScript({ master: MASTER, choice: "once" });
      mock.down = true;
      try {
        expect(JSON.parse(textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } })))).toEqual({ result: "unavailable" });
      } finally {
        mock.down = false;
      }
    } finally {
      await m.close();
    }
    // 複製に失敗する(自動処理用の保管庫の同期先が拒否する): 自動処理用のトークンを無効にする
    const s2 = await setup();
    const m2 = await s2.connect();
    try {
      for (const [tok, vault] of [...mock.tokens]) if (vault === s2.w.autoVault) mock.tokens.delete(tok);
      await s2.setScript({ master: MASTER, choice: "copy" });
      const r = JSON.parse(textOf(await m2.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } })));
      expect(r).toMatchObject({ password: PW_MAIN, returnedOnce: true, copied: false, copyFailure: "auth" });
    } finally {
      await m2.close();
    }
  });

  it("同時の要求: 同じプロセスの2つ目は busy。別のプロセスの2つ目も(錠のファイルで)busy。1つ目は最後まで進む", async () => {
    const s = await setup();
    const m = await s.connect();
    const m2 = await s.connect();
    try {
      await s.setScript({ master: MASTER, choice: "once", delayMs: 3000 });
      const first = m.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } });
      await new Promise((r) => setTimeout(r, 1200)); // 1つ目の子のプロセスがダイアログの待ちに入るまで
      const second = JSON.parse(textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "Main Key" } })));
      expect(second).toEqual({ result: "busy" });
      const other = JSON.parse(textOf(await m2.client.callTool({ name: "request_credential", arguments: { title: "Main Key" } })));
      expect(other).toEqual({ result: "busy" });
      const r = JSON.parse(textOf(await first));
      expect(r).toMatchObject({ password: PW_MAIN, returnedOnce: true });
      // 終わったら、また受ける
      await s.setScript({ master: MASTER, choice: "once" });
      const next = JSON.parse(textOf(await m2.client.callTool({ name: "request_credential", arguments: { title: "Main Key" } })));
      expect(next).toMatchObject({ password: KEY_MAIN });
    } finally {
      await m.close();
      await m2.close();
    }
  }, 60_000);

  it("audit: 自動処理用の保管庫の漏洩済みの項目名と回数を返す。パスワードの値・ハッシュを返さない。本体の項目は調べない", async () => {
    const s = await setup();
    const m = await s.connect();
    try {
      breach.requests = [];
      const text = textOf(await m.client.callTool({ name: "audit", arguments: {} }));
      expect(JSON.parse(text)).toEqual({ pwned: [{ title: "auto-pwned", count: 4242 }], clean: 1, skipped: 0, notApplicable: 1 });
      expect(text).not.toContain(PWNED_AUTO);
      expect(hasMarker(text)).toBe(false);
      expect(breach.requests).toHaveLength(2); // auto-web と auto-pwned の分だけ(本体の項目と API キーは送らない)
      expect(hasMarker(m.stderr())).toBe(false);
    } finally {
      await m.close();
    }
  });
});

describe("通常のビルドでは、ダイアログの差し替えが効かない", () => {
  it("同じ環境で、通常のビルド(dist/pwm.mjs)は台本を読まず(本物の PowerShell が見つからず unavailable)、テスト用のビルド(dist/test/pwm.mjs)は台本に従う", async () => {
    const { spawn } = await import("node:child_process");
    const s = await setup();
    await s.setScript({ master: MASTER, choice: "once" });
    // PowerShell が見つからない環境にして、本物のダイアログが画面に出ないようにする
    const env: Record<string, string | undefined> = { ...process.env, PWM_HOME: s.w.home.dir, PWM_TEST_DIALOG_FILE: s.scriptFile };
    for (const k of Object.keys(env)) if (k.toLowerCase() === "path") delete env[k];
    env.PATH = path.join(os.tmpdir(), "pwm-no-such-dir");
    // 同期先のモックはこのプロセスの中にあるので、同期的な起動(spawnSync)ではなく非同期で動かす
    const run = (js: string) =>
      new Promise<{ stdout: string }>((resolve) => {
        const c = spawn(process.execPath, [js, "approve-credential", "--title", "Main Site"], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "";
        c.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
        c.on("close", () => resolve({ stdout }));
      });

    const release = await run(path.join(ROOT, "dist", "pwm.mjs"));
    expect(JSON.parse(release.stdout)).toEqual({ result: "unavailable" });
    expect(await s.seen()).toBeNull(); // 台本は読まれていない

    const test = await run(path.join(ROOT, "dist", "test", "pwm.mjs"));
    expect(JSON.parse(test.stdout)).toMatchObject({ result: "ok", credential: { password: PW_MAIN }, returnedOnce: true });
    expect(await s.seen()).not.toBeNull();
  });
});
