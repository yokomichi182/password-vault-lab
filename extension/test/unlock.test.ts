import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../src/shared/base64.ts";
import { fetchVault } from "../src/shared/sync.ts";
import { performUnlock, type LocalState } from "../src/shared/unlock.ts";
import * as kdbxwebNs from "kdbxweb";
import { createTokenVault, resetArgon2, setupArgon2 } from "../src/shared/vault.ts";
import { CANARY } from "./canary.ts";
import { MASTER, makeKdbx } from "./helpers.ts";

const TOKEN = `${CANARY}-token`;
const settings = { syncUrl: "http://localhost:8788", vaultName: "main", sessionHours: 8, onload: true };

async function baseLocal(extra: Partial<LocalState> = {}): Promise<LocalState> {
  return {
    settings,
    tokenKdbx: bytesToBase64(await createTokenVault(MASTER, TOKEN)),
    ...extra,
  };
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
}

function serverFetch(handler: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
    });
    return handler();
  }) as typeof fetch;
  return { impl, calls };
}

const vaultResponse = (bytes: Uint8Array, version = 3) =>
  new Response(bytes as BodyInit, { status: 200, headers: { "x-vault-version": String(version) } });

describe("保管庫の取得とロック解除", () => {
  it("取得して開く。GET だけを呼び、版と暗号文を返す", async () => {
    const vault = await makeKdbx(MASTER, [{ title: "a", password: `${CANARY}-a` }]);
    const { impl, calls } = serverFetch(() => vaultResponse(vault, 7));
    const r = await performUnlock(MASTER, await baseLocal(), impl, () => new Date("2026-10-28T00:00:00Z"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("server");
    expect(r.items).toHaveLength(1);
    expect(r.newCipher?.version).toBe(7);
    expect(r.newCipher?.at).toBe("2026-10-28T00:00:00.000Z");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("http://localhost:8788/vaults/main");
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    // 戻り値にマスターパスワードもトークンも入らない
    const dump = JSON.stringify({ ...r, items: [] });
    expect(dump).not.toContain(MASTER);
    expect(dump).not.toContain(TOKEN);
  });

  it("マスターパスワードが違うと、通信せずに『違う』を返す", async () => {
    const { impl, calls } = serverFetch(() => new Response("x"));
    const r = await performUnlock("wrong", await baseLocal(), impl);
    expect(r).toEqual({ ok: false, error: "wrong-master" });
    expect(calls).toHaveLength(0);
  });

  it("設定が無いと not-configured", async () => {
    expect(await performUnlock(MASTER, {})).toEqual({ ok: false, error: "not-configured" });
  });

  it("404 は『保管庫が空』で、解除しない(手元の暗号文があっても)", async () => {
    const cached = await makeKdbx(MASTER, [{ title: "old", password: `${CANARY}-o` }]);
    const local = await baseLocal({ vaultCipher: bytesToBase64(cached), lastSync: "2026-01-01T00:00:00.000Z" });
    const { impl } = serverFetch(() => new Response(JSON.stringify({ error: "empty vault" }), { status: 404 }));
    expect(await performUnlock(MASTER, local, impl)).toEqual({ ok: false, error: "empty" });
  });

  it("通信できないときは、前回の暗号文で開き、前回の同期の日時を返す", async () => {
    const cached = await makeKdbx(MASTER, [{ title: "old", password: `${CANARY}-o` }]);
    const local = await baseLocal({ vaultCipher: bytesToBase64(cached), lastSync: "2026-01-01T00:00:00.000Z" });
    const { impl } = serverFetch(() => {
      throw new TypeError("offline");
    });
    const r = await performUnlock(MASTER, local, impl);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("cache");
    expect(r.note).toBe("offline");
    expect(r.lastSync).toBe("2026-01-01T00:00:00.000Z");
    expect(r.newCipher).toBeUndefined();
    expect(r.items.map((i) => i.title)).toEqual(["old"]);
  });

  it("通信できず、手元の暗号文も無いときは unreachable", async () => {
    const { impl } = serverFetch(() => {
      throw new TypeError("offline");
    });
    expect(await performUnlock(MASTER, await baseLocal(), impl)).toEqual({ ok: false, error: "unreachable" });
  });

  it("トークンが受け付けられないとき(401)は手元の暗号文で開き、理由を auth とする", async () => {
    const cached = await makeKdbx(MASTER, [{ title: "old", password: `${CANARY}-o` }]);
    const local = await baseLocal({ vaultCipher: bytesToBase64(cached), lastSync: "2026-01-01T00:00:00.000Z" });
    const { impl } = serverFetch(() => new Response("{}", { status: 401 }));
    const r = await performUnlock(MASTER, local, impl);
    expect(r.ok && r.note).toBe("auth");
  });

  it("サーバーの版が開けないとき(別のパスワードで作られた保管庫)は、解除せず、新しい暗号文も返さない", async () => {
    const other = await makeKdbx("another-master", [{ title: "x", password: `${CANARY}-x` }]);
    const cached = await makeKdbx(MASTER, [{ title: "old", password: `${CANARY}-o` }]);
    const local = await baseLocal({ vaultCipher: bytesToBase64(cached) });
    const { impl } = serverFetch(() => vaultResponse(other, 9));
    const r = await performUnlock(MASTER, local, impl);
    expect(r).toEqual({ ok: false, error: "vault-unopenable" });
  });
});

describe("解除の失敗の分け方", () => {
  const kdbxweb = ((kdbxwebNs as unknown as { default?: typeof kdbxwebNs }).default ?? kdbxwebNs) as typeof kdbxwebNs;
  // 署名・ヘッダーの形が崩れた、読み取れないバイト列にする(本文だけを書き換えると HMAC の不一致で鍵の誤りと区別できない)
  const broken = (b: Uint8Array) => b.slice(0, 40);
  const noMarker = (r: unknown, errors: unknown[]) => {
    expect(JSON.stringify(r)).not.toContain(CANARY);
    for (const e of errors) expect(String((e as Error)?.message ?? e)).not.toContain(CANARY);
  };

  it("正しい KDBX に誤ったマスターパスワード: wrong-master", async () => {
    const r = await performUnlock("another-master", await baseLocal(), serverFetch(() => new Response("x", { status: 500 })).impl);
    expect(r).toEqual({ ok: false, error: "wrong-master" });
    noMarker(r, []);
  });

  it("壊したバイト列(トークン入れ): open-failed", async () => {
    const tokenBytes = broken(await createTokenVault(MASTER, TOKEN));
    const local = await baseLocal({ tokenKdbx: bytesToBase64(tokenBytes) });
    const r = await performUnlock(MASTER, local, serverFetch(() => new Response("x", { status: 500 })).impl);
    expect(r).toEqual({ ok: false, error: "open-failed" });
    noMarker(r, []);
  });

  it("壊したバイト列(サーバーの保管庫): open-failed。手元の暗号文は返さない", async () => {
    const vault = broken(await makeKdbx(MASTER, [{ title: "a", password: `${CANARY}-a` }]));
    const { impl } = serverFetch(() => vaultResponse(vault, 4));
    const r = await performUnlock(MASTER, await baseLocal(), impl);
    expect(r).toEqual({ ok: false, error: "open-failed" });
    noMarker(r, []);
  });

  it("Argon2 の実装が例外を投げる: open-failed。メッセージに目印は入らない", async () => {
    const local = await baseLocal();
    const thrown = new Error("wasm failure");
    try {
      setupArgon2();
      kdbxweb.CryptoEngine.setArgon2Impl(async () => {
        throw thrown;
      });
      const r = await performUnlock(MASTER, local, serverFetch(() => new Response("x", { status: 500 })).impl);
      expect(r).toEqual({ ok: false, error: "open-failed" });
      noMarker(r, [thrown]);
    } finally {
      resetArgon2();
      setupArgon2();
    }
  });
});

describe("fetchVault", () => {
  it("PUT など書き込みは作らない。GET だけ", async () => {
    const { impl, calls } = serverFetch(() => new Response("x", { status: 500 }));
    expect(await fetchVault("https://sync.example.test/ignored/path", "main", TOKEN, impl)).toEqual({ kind: "unreachable" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(calls[0]!.url).toBe("https://sync.example.test/vaults/main");
  });
});
