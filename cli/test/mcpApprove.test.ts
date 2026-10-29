import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { sanitizeClientName, usernameHint } from "../src/approve/protocol.ts";
import { createServer, type McpDeps } from "../src/mcpServer.ts";
import { CANARY_AUTOM, CANARY_MAIN, hasMarker, makeCtx, makeHome, registerHomeScan } from "./helpers.ts";

registerHomeScan();

// 4-1 の 1(AI に返る形)、4、5、11 の一部。子のプロセスは差し替える(子の中身は approve.test.ts)。
const PW = `${CANARY_MAIN}-from-main`;
const OK_LINE = JSON.stringify({
  result: "ok",
  credential: { username: "alice", password: PW, url: "https://x.example.test/", notes: "", type: "password", environment: "", expires: "" },
  returnedOnce: true,
  copied: false,
});

type Text = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: unknown): string => (r as Text).content.map((c) => c.text).join("");

async function start(home: string, deps: McpDeps, clientName = "unit-client") {
  const t = makeCtx(home, { tty: false });
  const server = createServer(t.ctx, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: clientName, version: "0" });
  await client.connect(b);
  return { client, stderr: t.stderr, close: () => client.close() };
}

describe("request_credential(MCP の側)", () => {
  it("子の標準出力のとおりに返す: 成功は read_credential と同じ形に returnedOnce と copied を足したもの。失敗は result だけ", async () => {
    const h = await makeHome([{ title: "auto-item", password: `${CANARY_AUTOM}-a` }]);
    const lines = [
      OK_LINE,
      JSON.stringify({ result: "ok", credential: { username: "u", password: PW, url: "", notes: "", type: "apikey", environment: "live", expires: "" }, returnedOnce: false, copied: true, breach: { status: "notApplicable" } }),
      JSON.stringify({ result: "ok", credential: { username: "u", password: PW, url: "", notes: "", type: "password", environment: "", expires: "" }, returnedOnce: true, copied: false, copyFailure: "offline" }),
      '{"result":"denied"}',
      '{"result":"not_found"}',
      '{"result":"busy"}',
      '{"result":"unavailable"}',
      "", // 子が何も出さなかった
      "not json",
      '{"result":"ok","credential":{"password":1}}', // 形が違う
      '{"result":"allow","password":"x"}', // 知らない結果
    ];
    let i = 0;
    const m = await start(h.dir, { approve: async () => lines[i++]! });
    const results: unknown[] = [];
    for (let k = 0; k < lines.length; k++) {
      const r = (await m.client.callTool({ name: "request_credential", arguments: { title: "Main Site" } })) as Text;
      expect(r.isError).not.toBe(true);
      results.push(JSON.parse(textOf(r)));
    }
    expect(results[0]).toEqual({ username: "alice", password: PW, url: "https://x.example.test/", notes: "", type: "password", environment: "", expires: "", returnedOnce: true, copied: false });
    expect(results[1]).toMatchObject({ type: "apikey", returnedOnce: false, copied: true, breach: { status: "notApplicable" } });
    expect(results[2]).toMatchObject({ returnedOnce: true, copied: false, copyFailure: "offline" });
    expect(results.slice(3)).toEqual([
      { result: "denied" },
      { result: "not_found" },
      { result: "busy" },
      { result: "unavailable" },
      { result: "unavailable" },
      { result: "unavailable" },
      { result: "unavailable" },
      { result: "unavailable" },
    ]);
    // 標準エラーには結果の種類だけ(項目名も値も出ない)
    const err = m.stderr();
    expect(err).toContain("pwm-mcp: request_credential ok");
    expect(err).toContain("pwm-mcp: request_credential denied");
    expect(err).not.toContain("Main Site");
    expect(hasMarker(err)).toBe(false);
    await m.close();
  });

  it("子の実行が例外になっても unavailable", async () => {
    const h = await makeHome([{ title: "auto-item", password: `${CANARY_AUTOM}-a` }]);
    const m = await start(h.dir, { approve: () => Promise.reject(new Error("spawn failed")) });
    const r = await m.client.callTool({ name: "request_credential", arguments: { title: "x" } });
    expect(JSON.parse(textOf(r))).toEqual({ result: "unavailable" });
    // 道具が渡されていないときも unavailable
    const m2 = await start(h.dir, {});
    expect(JSON.parse(textOf(await m2.client.callTool({ name: "request_credential", arguments: { title: "x" } })))).toEqual({ result: "unavailable" });
    await m.close();
    await m2.close();
  });

  it("自動処理用の保管庫に同じ項目名があるとき、ダイアログ(子のプロセス)を出さずに read_credential を勧めるエラーを返す。無い項目名は進む", async () => {
    const h = await makeHome([{ title: "in-auto", password: `${CANARY_AUTOM}-a` }]);
    let calls = 0;
    const m = await start(h.dir, { approve: async () => (calls++, '{"result":"denied"}') });
    const r = (await m.client.callTool({ name: "request_credential", arguments: { title: "in-auto" } })) as Text;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("read_credential");
    expect(calls).toBe(0);
    const r2 = (await m.client.callTool({ name: "request_credential", arguments: { title: "not-in-auto" } })) as Text;
    expect(JSON.parse(textOf(r2))).toEqual({ result: "denied" });
    expect(calls).toBe(1);
    // 空の項目名はエラー
    expect(((await m.client.callTool({ name: "request_credential", arguments: { title: "" } })) as Text).isError).toBe(true);
    await m.close();
  });

  it("自動処理用の保管庫が無い PC でも進む(複製はできないだけ)", async () => {
    const h = await makeHome([]);
    const { rm } = await import("node:fs/promises");
    await rm(`${h.dir}/automation.kdbx`);
    let calls = 0;
    const m = await start(h.dir, { approve: async () => (calls++, '{"result":"denied"}') });
    expect(JSON.parse(textOf(await m.client.callTool({ name: "request_credential", arguments: { title: "x" } })))).toEqual({ result: "denied" });
    expect(calls).toBe(1);
    await m.close();
  });

  it("2つ目の同時の要求は、ダイアログを出さずに busy。1つ目が終わればまた受ける", async () => {
    const h = await makeHome([{ title: "auto-item", password: `${CANARY_AUTOM}-a` }]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const m = await start(h.dir, {
      approve: async () => {
        calls += 1;
        await gate;
        return OK_LINE;
      },
    });
    const first = m.client.callTool({ name: "request_credential", arguments: { title: "a" } });
    await new Promise((r) => setTimeout(r, 300)); // 1つ目が子を待つ状態になるまで
    const second = (await m.client.callTool({ name: "request_credential", arguments: { title: "b" } })) as Text;
    expect(JSON.parse(textOf(second))).toEqual({ result: "busy" });
    expect(calls).toBe(1);
    release();
    expect(JSON.parse(textOf(await first)).password).toBe(PW);
    const third = (await m.client.callTool({ name: "request_credential", arguments: { title: "c" } })) as Text;
    expect(JSON.parse(textOf(third)).password).toBe(PW); // gate は開いたまま
    expect(calls).toBe(2);
    await m.close();
  });

  it("要求した AI の名前(initialize の clientInfo.name)を、整えて子に渡す", async () => {
    const h = await makeHome([{ title: "auto-item", password: `${CANARY_AUTOM}-a` }]);
    const seen: { title: string; client: string }[] = [];
    const m = await start(h.dir, { approve: async (a) => (seen.push(a), '{"result":"denied"}') }, "ev\u0007il\nname");
    await m.client.callTool({ name: "request_credential", arguments: { title: "T" } });
    expect(seen).toEqual([{ title: "T", client: "ev il name" }]);
    await m.close();
  });

  it("sanitizeClientName と usernameHint", () => {
    expect(sanitizeClientName("a\u0000b‪c")).toBe("a b‪c");
    expect(sanitizeClientName("x".repeat(100))).toHaveLength(64);
    expect(sanitizeClientName(undefined)).toBe("(unknown)");
    expect(sanitizeClientName("\n\t ")).toBe("(unknown)");
    expect(usernameHint("")).toBe("…");
    expect(usernameHint("ab")).toBe("…");
    expect(usernameHint("abc")).toBe("ab…");
    expect(usernameHint("あいう")).toBe("あい…");
    expect(usernameHint("😀😀😀")).toBe("😀😀…");
  });
});
