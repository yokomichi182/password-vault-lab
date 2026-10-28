import { describe, expect, it } from "vitest";
import { checkBreach, countFromRange, sha1Hex } from "../src/shared/breach.ts";
import { CANARY } from "./canary.ts";

const BASE = "http://localhost:9999";

function fakeFetch(body: string, status = 200) {
  const calls: { url: string; headers: Record<string, string>; credentials?: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      credentials: init?.credentials,
    });
    return new Response(body, { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("漏洩チェック", () => {
  it("3. 送るのは先頭5文字だけで、Add-Padding: true が付く。一致する末尾で回数が出る。回数0の行は無視する", async () => {
    const password = `${CANARY}-pw`;
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const body = ["0000000000000000000000000000000000A:0", `${suffix}:42`, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0"].join("\r\n");
    const { impl, calls } = fakeFetch(body);
    const r = await checkBreach({ itemType: "", password }, BASE, impl);
    expect(r).toEqual({ status: "pwned", count: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/range/${prefix}`);
    expect(calls[0]!.headers["add-padding"]).toBe("true");
    expect(calls[0]!.credentials).toBe("omit");
    // 送った文字列に、ハッシュの残りもパスワードも入っていない
    expect(calls[0]!.url).not.toContain(suffix);
    expect(calls[0]!.url).not.toContain(CANARY);
  });

  it("回数0の行(パディング)に一致しても漏洩にしない", async () => {
    const password = `${CANARY}-pw`;
    const suffix = (await sha1Hex(password)).slice(5);
    const { impl } = fakeFetch(`${suffix}:0\r\n`);
    expect(await checkBreach({ itemType: "password", password }, BASE, impl)).toEqual({ status: "clean" });
    expect(countFromRange(`${suffix}:0`, suffix)).toBe(0);
  });

  it("一致する行が無ければ clean", async () => {
    const { impl } = fakeFetch("0000000000000000000000000000000000A:3\r\n");
    expect(await checkBreach({ itemType: "", password: `${CANARY}-x` }, BASE, impl)).toEqual({ status: "clean" });
  });

  it("8. 通信の失敗と HTTP エラーを漏洩なしにしない", async () => {
    const failing = (async () => {
      throw new TypeError(`network ${CANARY}`);
    }) as typeof fetch;
    const r1 = await checkBreach({ itemType: "", password: `${CANARY}-pw` }, BASE, failing);
    expect(r1).toEqual({ status: "error" });
    expect(JSON.stringify(r1)).not.toContain(CANARY);
    const { impl } = fakeFetch("oops", 503);
    expect(await checkBreach({ itemType: "", password: `${CANARY}-pw` }, BASE, impl)).toEqual({ status: "error" });
    const { impl: rl } = fakeFetch("", 429);
    expect(await checkBreach({ itemType: "", password: `${CANARY}-pw` }, BASE, rl)).toEqual({ status: "error" });
  });

  it("8. API キーと知らない種類は送らない", async () => {
    for (const itemType of ["apikey", "note"]) {
      const { impl, calls } = fakeFetch("");
      const r = await checkBreach({ itemType, password: `${CANARY}-key` }, BASE, impl);
      expect(r).toEqual({ status: "not-applicable" });
      expect(calls).toHaveLength(0);
    }
  });
});
