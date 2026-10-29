import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { FrameReader, MAX_FRAME_BYTES, encodeFrame } from "../src/bridge/frames.ts";
import { BridgeHost, type HostToExt } from "../src/bridge/host.ts";
import { bridgeDir, parseFillRequest, parseFillResponse, requestFill, reqName, resName } from "../src/bridge/files.ts";
import { createServer, type McpDeps } from "../src/mcpServer.ts";
import { runPwm } from "../src/pwm.ts";
import { CANARY_AUTOM, CANARY_MAIN, hasMarker, makeCtx, makeHome, registerHomeScan, tmpHome } from "./helpers.ts";

registerHomeScan();

const ROOT = path.resolve(import.meta.dirname, "..");
const BRIDGE_JS = path.join(ROOT, "dist", "pwm-bridge.mjs");
const MCP_JS = path.join(ROOT, "dist", "pwm-mcp.mjs");
const PWM_JS = path.join(ROOT, "dist", "pwm.mjs");

const ID = "0123456789abcdef0123456789abcdef";
const ID2 = "fedcba9876543210fedcba9876543210";

type Text = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: unknown): string => (r as Text).content.map((c) => c.text).join("");

// ---- 4-1 の 8: request_fill ----

describe("request_fill: つなぎの置き場に書く依頼", () => {
  it("依頼のファイルに入るのは、ID・項目名・url・AI の名前・時刻だけ。値は入らない。応答が来たら読んで、依頼と応答のファイルを消す", async () => {
    const home = await tmpHome();
    const dir = bridgeDir(home);
    const seen: string[] = [];
    const p = requestFill({ home, title: "Site A", url: "https://a.example.test", client: "my-ai", timeoutMs: 5000, pollMs: 20 });
    // 依頼のファイルが現れるのを待ち、内容を記録してから応答を置く
    let id = "";
    for (let i = 0; i < 100 && !id; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const names = await readdir(dir).catch(() => [] as string[]);
      const req = names.find((n) => n.startsWith("req-"));
      if (req) {
        seen.push(await readFile(path.join(dir, req), "utf8"));
        id = req.slice(4, 36);
      }
    }
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const body = JSON.parse(seen[0]!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["at", "client", "id", "title", "url", "v"]);
    expect(body).toMatchObject({ v: 1, id, title: "Site A", url: "https://a.example.test", client: "my-ai" });
    await writeFile(path.join(dir, resName(id)), JSON.stringify({ v: 1, id, result: "filled" }));
    expect(await p).toBe("filled");
    expect(await readdir(dir)).toEqual([]); // どちらも消えている
  });

  it("応答が来ないときは、待ち時間の上限で unavailable。依頼のファイルを残さない。壊れた応答・別の ID の応答・知らない結果も unavailable", async () => {
    const home = await tmpHome();
    const t0 = Date.now();
    expect(await requestFill({ home, title: "x", client: "c", timeoutMs: 300, pollMs: 20 })).toBe("unavailable");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(await readdir(bridgeDir(home))).toEqual([]);
    // 待ち時間は差し替えられる(60 秒の既定を、時計を進めて確かめる)
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const r = await requestFill({
      home,
      title: "x",
      client: "c",
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    expect(r).toBe("unavailable");
    expect(clock - 1_000_000).toBeGreaterThanOrEqual(60_000);
    expect(clock - 1_000_000).toBeLessThan(60_200);

    for (const bad of ["not json", JSON.stringify({ v: 1, id: ID2, result: "filled" }), JSON.stringify({ v: 1, id: "ID", result: "allow" })]) {
      expect(parseFillResponse(bad, ID)).toBeNull();
    }
  });

  it("依頼の形の検査: 値の欄・知らない欄は捨てる。長すぎる、ID が違う、型が違うものは null", () => {
    const base = { v: 1, id: ID, title: "t", client: "c", at: 1 };
    expect(parseFillRequest(JSON.stringify({ ...base, password: "x", extra: 1 }))).toEqual({ v: 1, id: ID, title: "t", client: "c", at: 1 });
    expect(parseFillRequest(JSON.stringify({ ...base, url: "https://x.example.test" }))?.url).toBe("https://x.example.test");
    for (const bad of [
      { ...base, v: 2 },
      { ...base, id: "../../x" },
      { ...base, title: "" },
      { ...base, title: "x".repeat(2000) },
      { ...base, url: 5 },
      { ...base, client: 5 },
      { ...base, at: "now" },
    ]) {
      expect(parseFillRequest(JSON.stringify(bad)), JSON.stringify(bad).slice(0, 40)).toBeNull();
    }
    expect(parseFillRequest(JSON.stringify(base), ID2)).toBeNull();
    expect(parseFillRequest("x".repeat(20000))).toBeNull();
    expect(parseFillRequest("[1]")).toBeNull();
  });
});

// ---- 4-1 の 9: pwm-bridge ----

describe("pwm-bridge(ホストの中身)", () => {
  async function setup(nowMs = 10_000_000) {
    const home = await tmpHome();
    const dir = bridgeDir(home);
    await mkdir(dir, { recursive: true });
    const sent: HostToExt[] = [];
    let clock = nowMs;
    const host = new BridgeHost({ dir, send: (m) => void sent.push(m), now: () => clock });
    return { dir, sent, host, setNow: (n: number) => (clock = n), nowMs };
  }
  const reqFile = (id: string, over: Record<string, unknown> = {}, at = 10_000_000) =>
    JSON.stringify({ v: 1, id, title: "Site A", client: "c", at, ...over });

  it("依頼を拾って拡張に渡し、依頼のファイルを消す。拡張の結果を応答のファイルに書く", async () => {
    const s = await setup();
    await writeFile(path.join(s.dir, reqName(ID)), reqFile(ID, { url: "https://a.example.test" }));
    await s.host.scan();
    expect(s.sent).toEqual([{ type: "fill", id: ID, title: "Site A", url: "https://a.example.test", client: "c", at: 10_000_000 }]);
    expect(await readdir(s.dir)).toEqual([]); // 処理した依頼は消えている
    // 同じ依頼は二度渡さない
    await s.host.scan();
    expect(s.sent).toHaveLength(1);
    await s.host.onExtensionMessage({ type: "fill-result", id: ID, result: "filled" });
    expect(JSON.parse(await readFile(path.join(s.dir, resName(ID)), "utf8"))).toEqual({ v: 1, id: ID, result: "filled" });
    expect(s.host.pendingCount()).toBe(0);
  });

  it("90秒より古い依頼は捨てる(拡張に渡さず、ファイルも消す)", async () => {
    const s = await setup();
    await writeFile(path.join(s.dir, reqName(ID)), reqFile(ID, {}, 10_000_000 - 91_000));
    await writeFile(path.join(s.dir, reqName(ID2)), reqFile(ID2, {}, 10_000_000 - 89_000));
    await s.host.scan();
    expect(s.sent.map((m) => (m.type === "fill" ? m.id : m.type))).toEqual([ID2]);
    expect(await readdir(s.dir)).toEqual([]);
  });

  it("知らない形の依頼(値の欄、壊れた JSON、ID とファイル名の不一致、長すぎるファイル)は捨てる。置き場にある req- でないファイルは触らない", async () => {
    const s = await setup();
    await writeFile(path.join(s.dir, reqName(ID)), "{broken");
    await writeFile(path.join(s.dir, reqName(ID2)), reqFile(ID)); // ID とファイル名が合わない
    const ID3 = "11111111111111111111111111111111";
    await writeFile(path.join(s.dir, reqName(ID3)), "x".repeat(20_000));
    await writeFile(path.join(s.dir, "req-evil.json"), reqFile(ID));
    await writeFile(path.join(s.dir, "notes.txt"), "keep");
    await s.host.scan();
    expect(s.sent).toEqual([]);
    expect((await readdir(s.dir)).sort()).toEqual(["notes.txt", "req-evil.json"]);
  });

  it("拡張からの知らない形のメッセージは捨てる(応答を書かない)。待っていない ID、知らない結果、型違い", async () => {
    const s = await setup();
    await writeFile(path.join(s.dir, reqName(ID)), reqFile(ID));
    await s.host.scan();
    const bad: unknown[] = [
      null,
      "text",
      [],
      { type: "other", id: ID, result: "filled" },
      { type: "fill-result", id: ID2, result: "filled" }, // 待っていない
      { type: "fill-result", id: "../x", result: "filled" },
      { type: "fill-result", id: ID, result: "allowed" }, // 知らない結果
      { type: "fill-result", id: ID, result: { v: 1 } },
      { type: "fill-result", result: "filled" },
    ];
    for (const m of bad) await s.host.onExtensionMessage(m);
    expect(await readdir(s.dir)).toEqual([]);
    expect(s.host.pendingCount()).toBe(1); // 本物の結果をまだ待っている
    for (const result of ["denied", "not_found", "locked", "unavailable"] as const) {
      const id = ID;
      await s.host.onExtensionMessage({ type: "fill-result", id, result });
      const f = JSON.parse(await readFile(path.join(s.dir, resName(id)), "utf8"));
      expect(f.result).toBe(result);
      // 次の結果のために、もう一度待ち状態にする
      await writeFile(path.join(s.dir, reqName(id)), reqFile(id));
      await s.host.scan();
    }
  });

  it("読まれないまま残った古い応答のファイルを消す。新しい応答は残す", async () => {
    const s = await setup(Date.now());
    const oldRes = path.join(s.dir, resName(ID));
    const newRes = path.join(s.dir, resName(ID2));
    await writeFile(oldRes, JSON.stringify({ v: 1, id: ID, result: "filled" }));
    await writeFile(newRes, JSON.stringify({ v: 1, id: ID2, result: "filled" }));
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(oldRes, old, old);
    await s.host.scan();
    expect(await readdir(s.dir)).toEqual([resName(ID2)]);
  });

  it("枠: 長さの前置きで切り出し、壊れた JSON は捨て、上限を超える枠で止まる", () => {
    const got: unknown[] = [];
    let tooBig = 0;
    const r = new FrameReader((m) => got.push(m), () => tooBig++);
    const a = encodeFrame({ type: "fill-result", id: ID, result: "filled" });
    const b = encodeFrame({ n: 2 });
    r.push(a.subarray(0, 3)); // 途中で切れても待つ
    r.push(Buffer.concat([a.subarray(3), b]));
    const broken = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from("{x}")]);
    r.push(broken);
    r.push(encodeFrame({ n: 3 }));
    expect(got).toEqual([{ type: "fill-result", id: ID, result: "filled" }, { n: 2 }, { n: 3 }]);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    r.push(head);
    expect(tooBig).toBe(1);
    r.push(encodeFrame({ n: 4 })); // 止まったあとは読まない
    expect(got).toHaveLength(3);
  });

  it("束ねた pwm-bridge.mjs に、fetch・本体の保管庫のファイル名・本体用のモジュール・同期の処理が入っていない。pwm-mcp.mjs にも入っていない(つなぎの処理は入る)", async () => {
    const bridge = await readFile(BRIDGE_JS, "utf8");
    const mcp = await readFile(MCP_JS, "utf8");
    const pwm = await readFile(PWM_JS, "utf8");
    for (const needle of ["main.token.kdbx", "main.kdbx", "withMainDb", "openMainWithMaster", "putVault", "fetchVault", "System.Windows.Forms", "kdbxweb", "approve.lock"]) {
      expect(bridge.includes(needle), `bridge has ${needle}`).toBe(false);
    }
    expect(/(^|[^A-Za-z0-9_$.])fetch(?![A-Za-z0-9_$])/.test(bridge)).toBe(false);
    expect(bridge.includes("globalThis.fetch")).toBe(false);
    for (const mod of ["node:http", "node:https", "node:net", "node:dgram", "node:tls"]) expect(bridge.includes(`"${mod}"`), mod).toBe(false);
    // 検査が空振りでないことの確認: つなぎの処理は入っている
    expect(bridge.includes("fill-result") && bridge.includes("watch(")).toBe(true);
    expect(mcp.includes("requestFill") && pwm.includes("requestFill")).toBe(true);
    expect(mcp.includes("fill-result")).toBe(false); // pwm-mcp はホストの処理を持たない
  });
});

// ---- 実際のプロセスで: pwm-bridge.mjs を起動し、拡張のふりをして、pwm-mcp と pwm fill の依頼を通す ----

class FakeExtension {
  frames: unknown[] = [];
  exitCode: number | null = null;
  private child;
  private reader = new FrameReader((m) => this.frames.push(m), () => undefined);
  stderr = "";
  constructor(home: string, args: string[] = []) {
    this.child = spawn(process.execPath, [BRIDGE_JS, ...args], { env: { ...process.env, PWM_HOME: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout.on("data", (d: Buffer) => this.reader.push(d));
    this.child.stderr.on("data", (d: Buffer) => (this.stderr += d.toString("utf8")));
    this.child.on("close", (c) => (this.exitCode = c ?? -1));
  }
  send(msg: unknown): void {
    this.child.stdin.write(encodeFrame(msg));
  }
  sendRaw(b: Buffer): void {
    this.child.stdin.write(b);
  }
  async waitFrame(pred: (m: Record<string, unknown>) => boolean, ms = 10_000): Promise<Record<string, unknown>> {
    const end = Date.now() + ms;
    for (;;) {
      const f = this.frames.find((m) => pred(m as Record<string, unknown>));
      if (f) return f as Record<string, unknown>;
      if (Date.now() > end) throw new Error("no frame");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  async close(): Promise<number | null> {
    this.child.stdin.end();
    for (let i = 0; i < 100 && this.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
    return this.exitCode;
  }
}

describe("pwm-bridge.mjs を実際に動かす", () => {
  it("起動したら hello を送る。依頼が置かれたら拡張に渡し、拡張の結果を pwm fill に返す。拡張が閉じたら終わる。標準エラーに何も出ない", async () => {
    const home = await tmpHome();
    const ext = new FakeExtension(home, ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]);
    await ext.waitFrame((m) => m.type === "hello");
    const t = makeCtx(home, { tty: false });
    // 実際の pwm fill のコマンド(待ちは本物)
    const run = runPwm(["fill", "--title", "Site A", "--url", "https://a.example.test"], t.ctx);
    const fill = await ext.waitFrame((m) => m.type === "fill");
    expect(fill).toMatchObject({ title: "Site A", url: "https://a.example.test", client: "pwm fill (CLI)" });
    expect(Object.keys(fill).sort()).toEqual(["at", "client", "id", "title", "type", "url"]);
    ext.send({ type: "fill-result", id: fill.id, result: "filled" });
    expect(await run).toBe(0);
    expect(t.stdout()).toBe("filled\n");
    expect(await readdir(bridgeDir(home))).toEqual([]);

    // 拒否・該当なし・ロック中は、終了コード 1 でその語を出す
    const answered = new Set<unknown>([fill.id]);
    for (const result of ["denied", "not_found", "locked"] as const) {
      const t2 = makeCtx(home, { tty: false });
      const run2 = runPwm(["fill", "--title", "Site B"], t2.ctx);
      const f = await ext.waitFrame((m) => m.type === "fill" && m.title === "Site B" && !answered.has(m.id));
      answered.add(f.id);
      ext.send({ type: "fill-result", id: f.id, result });
      expect(await run2).toBe(1);
      expect(t2.stdout()).toBe(`${result}\n`);
    }
    expect(ext.stderr).toBe("");
    expect(await ext.close()).toBe(0);
  });

  it("呼び出し元の形が違う引数、上限を超える枠は、終了コード 1 で止まる", async () => {
    const home = await tmpHome();
    const e1 = new FakeExtension(home, ["chrome-extension://evil/"]);
    expect(await e1.close()).toBe(1);
    const e2 = new FakeExtension(home);
    await e2.waitFrame((m) => m.type === "hello");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(10_000_000, 0);
    e2.sendRaw(head);
    for (let i = 0; i < 100 && e2.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
    expect(e2.exitCode).toBe(1);
  });
});

// ---- MCP の request_fill ----

async function start(home: string, deps: McpDeps, clientName = "unit-client") {
  const t = makeCtx(home, { tty: false });
  const server = createServer(t.ctx, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: clientName, version: "0" });
  await client.connect(b);
  return { client, stderr: t.stderr, close: () => client.close() };
}

describe("MCP の request_fill", () => {
  it("結果の語だけを返す。値・ユーザー名・オリジンは返さない。標準エラーには結果の種類だけ。AI の名前を整えて渡す。url は渡したときだけ付く", async () => {
    const h = await makeHome([{ title: "x", password: `${CANARY_AUTOM}-x` }]);
    const calls: { title: string; url?: string; client: string }[] = [];
    const results = ["filled", "denied", "not_found", "locked", "unavailable"] as const;
    let i = 0;
    const m = await start(h.dir, { fill: async (a) => (calls.push(a), results[i++ % 5]!) }, "a\u0007b");
    for (const expected of results) {
      const r = (await m.client.callTool({ name: "request_fill", arguments: { title: "Site A", url: "https://a.example.test" } })) as Text;
      expect(r.isError).not.toBe(true);
      expect(JSON.parse(textOf(r))).toEqual({ result: expected });
    }
    await m.client.callTool({ name: "request_fill", arguments: { title: "Site A" } });
    expect(calls[0]).toEqual({ title: "Site A", url: "https://a.example.test", client: "a b" });
    expect(calls[5]).toEqual({ title: "Site A", client: "a b" });
    const err = m.stderr();
    expect(err).toContain("pwm-mcp: request_fill filled");
    expect(err).not.toContain("Site A");
    expect(err).not.toContain("a.example.test");
    // 空の項目名・長すぎる url はエラー
    expect(((await m.client.callTool({ name: "request_fill", arguments: { title: "" } })) as Text).isError).toBe(true);
    expect(((await m.client.callTool({ name: "request_fill", arguments: { title: "t", url: "https://x/" + "a".repeat(3000) } })) as Text).isError).toBe(true);
    await m.close();
  });

  it("応答が来ないときは、待ち時間の上限で unavailable(待ち時間は差し替え)。依頼のファイルに値が入らず、終わったら残らない", async () => {
    const h = await makeHome([{ title: "x", password: `${CANARY_AUTOM}-x` }]);
    const m = await start(h.dir, { fillTimeoutMs: 400 });
    const t0 = Date.now();
    const r = (await m.client.callTool({ name: "request_fill", arguments: { title: "Site A" } })) as Text;
    expect(JSON.parse(textOf(r))).toEqual({ result: "unavailable" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390);
    expect(await readdir(bridgeDir(h.dir))).toEqual([]);
    await m.close();
  });

  it("ホストの動きを含めて通す(本物の requestFill と BridgeHost を、同じ置き場で)。ツールの結果と標準エラーに目印が出ない", async () => {
    const h = await makeHome([{ title: "x", password: `${CANARY_AUTOM}-x` }]);
    const sent: HostToExt[] = [];
    const host = new BridgeHost({ dir: bridgeDir(h.dir), send: (msg) => void sent.push(msg), now: () => Date.now() });
    const timer = setInterval(() => {
      void host.scan().then(async () => {
        for (const msg of sent.splice(0)) if (msg.type === "fill") await host.onExtensionMessage({ type: "fill-result", id: msg.id, result: msg.title === "ok" ? "filled" : "not_found" });
      });
    }, 30);
    try {
      const m = await start(h.dir, { fillTimeoutMs: 5000 });
      const a = textOf(await m.client.callTool({ name: "request_fill", arguments: { title: "ok" } }));
      const b = textOf(await m.client.callTool({ name: "request_fill", arguments: { title: "other" } }));
      expect(JSON.parse(a)).toEqual({ result: "filled" });
      expect(JSON.parse(b)).toEqual({ result: "not_found" });
      expect(hasMarker(a + b + m.stderr() + CANARY_MAIN.slice(0, 0))).toBe(false);
      await m.close();
    } finally {
      clearInterval(timer);
    }
    expect((await readdir(bridgeDir(h.dir))).filter((n) => n.startsWith("req-") || n.startsWith("res-"))).toEqual([]);
    expect((await stat(bridgeDir(h.dir))).isDirectory()).toBe(true);
  });
});
