import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CANARY, TOKEN_AUTO, TOKEN_MAIN, TOKEN_UNKNOWN } from "./tokens";

const BASE = "https://example.test";
const MAX = 1_900_000;

const logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
  vi.spyOn(console, m),
);
const errorBodies: string[] = [];

async function call(
  path: string,
  init: {
    method?: string;
    token?: string | null;
    headers?: Record<string, string>;
    body?: BodyInit | null;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const token = init.token === undefined ? TOKEN_MAIN : init.token;
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  const res = await SELF.fetch(
    new Request(BASE + path, {
      method: init.method ?? "GET",
      headers,
      body: init.body ?? null,
      // @ts-expect-error ストリーム本文用
      duplex: "half",
    }),
  );
  if (res.status >= 400) errorBodies.push(await res.clone().text());
  return res;
}

const put = (
  path: string,
  body: BodyInit | null,
  ifMatch: string | null,
  extra: Record<string, string> = {},
  token?: string | null,
) =>
  call(path, {
    method: "PUT",
    body,
    token,
    headers: { ...(ifMatch === null ? {} : { "If-Match": ifMatch }), ...extra },
  });

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

beforeEach(async () => {
  await env.DB.exec("DELETE FROM vault_versions");
});

describe("認証", () => {
  it("Authorization なしは 401", async () => {
    expect((await call("/vaults/main", { token: null })).status).toBe(401);
  });
  it("誤りのトークンは 401", async () => {
    expect((await call("/vaults/main", { token: TOKEN_UNKNOWN })).status).toBe(401);
  });
  it("Bearer 以外の形式は 401", async () => {
    const res = await call("/vaults/main", { token: null, headers: { Authorization: TOKEN_MAIN } });
    expect(res.status).toBe(401);
  });
  it("未知のパスと不正な保管庫名も認証なしでは 401", async () => {
    expect((await call("/", { token: null })).status).toBe(401);
    expect((await call("/vaults/BAD", { token: null })).status).toBe(401);
  });
  it("別の保管庫のトークンは 403", async () => {
    expect((await call("/vaults/automation", { token: TOKEN_MAIN })).status).toBe(403);
    expect((await call("/vaults/main", { token: TOKEN_AUTO })).status).toBe(403);
    expect((await put("/vaults/main", bytes(4), "0", {}, TOKEN_AUTO)).status).toBe(403);
    expect((await call("/vaults/main/history", { token: TOKEN_AUTO })).status).toBe(403);
  });
});

describe("保管庫名とルーティング", () => {
  it.each(["UPPER", "has_underscore", "a".repeat(33), "dot.name", "sp%20ace"])(
    "不正な名前 %s は 400",
    async (name) => {
      expect((await call(`/vaults/${name}`)).status).toBe(400);
    },
  );
  it("32 文字・数字とハイフンは通る（空なので 404 だが 400 ではない）", async () => {
    // トークンの保管庫名と違うので 403 になる。名前の検査は通っている。
    expect((await call(`/vaults/${"a-1".repeat(10)}xx`)).status).toBe(403);
  });
  it("未知のパスは 404、対応外メソッドは 405", async () => {
    expect((await call("/")).status).toBe(404);
    expect((await call("/vault")).status).toBe(404);
    expect((await call("/vaults/main/other")).status).toBe(404);
    expect((await call("/vaults/main", { method: "DELETE" })).status).toBe(405);
    expect((await call("/vaults/main/history", { method: "PUT" })).status).toBe(405);
  });
});

describe("保管庫の読み書き", () => {
  it("空の保管庫の GET は 404、If-Match: 0 で最初の版ができる", async () => {
    expect((await call("/vaults/main")).status).toBe(404);
    const res = await put("/vaults/main", bytes(10, 7), "0");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1 });
    const got = await call("/vaults/main");
    expect(got.status).toBe(200);
    expect(got.headers.get("X-Vault-Version")).toBe("1");
    expect(got.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("バイナリの往復で中身が変わらない", async () => {
    const original = new Uint8Array(70_000);
    for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 7) & 0xff;
    original.set(new TextEncoder().encode(CANARY), 100);
    expect((await put("/vaults/main", original, "0")).status).toBe(200);
    const got = new Uint8Array(await (await call("/vaults/main")).arrayBuffer());
    expect(got.length).toBe(original.length);
    expect(got.every((b, i) => b === original[i])).toBe(true);
    const v1 = new Uint8Array(await (await call("/vaults/main/history/1")).arrayBuffer());
    expect(v1.every((b, i) => b === original[i])).toBe(true);
  });

  it("If-Match が必須で、不正なら 400、なければ 428", async () => {
    expect((await put("/vaults/main", bytes(4), null)).status).toBe(428);
    expect((await put("/vaults/main", bytes(4), "abc")).status).toBe(400);
    expect((await put("/vaults/main", bytes(4), "-1")).status).toBe(400);
  });

  it("If-Match の不一致は 409 と現在の最新版", async () => {
    expect((await put("/vaults/main", bytes(4), "0")).status).toBe(200);
    const stale = await put("/vaults/main", bytes(4, 2), "0");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ version: 1 });
    const ahead = await put("/vaults/main", bytes(4, 2), "5");
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toEqual({ version: 1 });
    expect((await put("/vaults/main", bytes(4, 3), "1")).status).toBe(200);
  });

  it("同じ If-Match の PUT を同時に 2 つ投げると片方だけが通る", async () => {
    const [a, b] = await Promise.all([
      put("/vaults/main", bytes(8, 1), "0"),
      put("/vaults/main", bytes(8, 2), "0"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS c FROM vault_versions").first<{ c: number }>();
    expect(rows?.c).toBe(1);
  });

  it("空の本文は 400", async () => {
    expect((await put("/vaults/main", new Uint8Array(0), "0")).status).toBe(400);
    expect((await put("/vaults/main", null, "0")).status).toBe(400);
  });

  it("X-Device-Name を保存し、不正な長さは 400、省略は unknown", async () => {
    expect((await put("/vaults/main", bytes(4), "0", { "X-Device-Name": "pixel-test" })).status).toBe(200);
    expect((await put("/vaults/main", bytes(4), "1")).status).toBe(200);
    expect((await put("/vaults/main", bytes(4), "2", { "X-Device-Name": "x".repeat(65) })).status).toBe(400);
    expect((await put("/vaults/main", bytes(4), "2", { "X-Device-Name": "x".repeat(64) })).status).toBe(200);
    const hist = (await (await call("/vaults/main/history")).json()) as { device: string }[];
    expect(hist.map((h) => h.device)).toEqual(["x".repeat(64), "unknown", "pixel-test"]);
  });
});

describe("本文の上限", () => {
  it("1,900,000 バイトちょうどは通る", async () => {
    expect((await put("/vaults/main", bytes(MAX), "0")).status).toBe(200);
    const got = await (await call("/vaults/main")).arrayBuffer();
    expect(got.byteLength).toBe(MAX);
  });
  it("Content-Length が上限超なら 413", async () => {
    const res = await put("/vaults/main", bytes(MAX + 1), "0");
    expect(res.status).toBe(413);
    expect((await call("/vaults/main")).status).toBe(404);
  });
  it("Content-Length なし（ストリーム）で実際の長さが上限超なら 413", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(MAX));
        c.enqueue(bytes(1));
        c.close();
      },
    });
    const res = await put("/vaults/main", stream, "0");
    expect(res.status).toBe(413);
    expect((await call("/vaults/main")).status).toBe(404);
  });
});

describe("履歴と世代管理", () => {
  it("history は新しい順で version, sha256, device, created_at, size を返す", async () => {
    const body = new TextEncoder().encode(`${CANARY}-body`);
    await put("/vaults/main", body, "0", { "X-Device-Name": "dev-a" });
    await put("/vaults/main", bytes(5), "1", { "X-Device-Name": "dev-b" });
    const res = await call("/vaults/main/history");
    expect(res.status).toBe(200);
    const hist = (await res.json()) as {
      version: number;
      sha256: string;
      device: string;
      created_at: string;
      size: number;
    }[];
    expect(hist.map((h) => h.version)).toEqual([2, 1]);
    expect(hist[1]!.size).toBe(body.length);
    expect(hist[1]!.device).toBe("dev-a");
    const digest = await crypto.subtle.digest("SHA-256", body);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hist[1]!.sha256).toBe(hex);
    expect(new Date(hist[1]!.created_at).toISOString()).toBe(hist[1]!.created_at);
  });

  it("過去の版を取得でき、なければ 404", async () => {
    await put("/vaults/main", bytes(3, 1), "0");
    await put("/vaults/main", bytes(3, 2), "1");
    const v1 = await call("/vaults/main/history/1");
    expect(v1.status).toBe(200);
    expect(v1.headers.get("X-Vault-Version")).toBe("1");
    expect([...new Uint8Array(await v1.arrayBuffer())]).toEqual([1, 1, 1]);
    expect((await call("/vaults/main/history/9")).status).toBe(404);
    expect((await call("/vaults/main/history/abc")).status).toBe(404);
  });

  it("51 版目で最古の版が消え、他の保管庫には影響しない", async () => {
    await put("/vaults/automation", bytes(2, 9), "0", {}, TOKEN_AUTO);
    for (let v = 0; v < 50; v++) {
      expect((await put("/vaults/main", bytes(2, v & 0xff), String(v))).status).toBe(200);
    }
    let hist = (await (await call("/vaults/main/history")).json()) as { version: number }[];
    expect(hist.length).toBe(50);
    expect(hist.at(-1)!.version).toBe(1);

    expect((await put("/vaults/main", bytes(2, 50), "50")).status).toBe(200);
    hist = (await (await call("/vaults/main/history")).json()) as { version: number }[];
    expect(hist.length).toBe(50);
    expect(hist[0]!.version).toBe(51);
    expect(hist.at(-1)!.version).toBe(2);
    expect((await call("/vaults/main/history/1")).status).toBe(404);
    expect((await call("/vaults/main/history/2")).status).toBe(200);

    const other = (await (await call("/vaults/automation/history", { token: TOKEN_AUTO })).json()) as unknown[];
    expect(other.length).toBe(1);
  });

  it("最古版の削除に失敗した場合は 51 版目の書き込みもロールバックする", async () => {
    for (let v = 0; v < 50; v++) {
      expect((await put("/vaults/main", bytes(2, v & 0xff), String(v))).status).toBe(200);
    }
    await env.DB.prepare(
      `CREATE TRIGGER reject_history_delete
       BEFORE DELETE ON vault_versions
       BEGIN
         SELECT RAISE(ABORT, 'test delete failure');
       END`,
    ).run();
    try {
      expect((await put("/vaults/main", bytes(2, 50), "50")).status).toBe(500);
      const state = await env.DB.prepare(
        "SELECT COUNT(*) AS count, MAX(version) AS latest FROM vault_versions WHERE vault = 'main'",
      ).first<{ count: number; latest: number }>();
      expect(state).toEqual({ count: 50, latest: 50 });
    } finally {
      await env.DB.exec("DROP TRIGGER IF EXISTS reject_history_delete");
    }
  });
});

// 最後に実行すること。
describe("カナリア", () => {
  it("ログとエラーレスポンスに目印が出ていない", async () => {
    // 目印入りの本文・トークンでエラー系を一通り起こす。
    const canaryBody = new TextEncoder().encode(`${CANARY}-secret-body`);
    await put("/vaults/main", canaryBody, "0");
    await put("/vaults/main", canaryBody, "0"); // 409
    await put("/vaults/main", canaryBody, "x"); // 400
    await put("/vaults/main", canaryBody, null); // 428
    await put("/vaults/main", bytes(MAX + 1), "1"); // 413
    await call("/vaults/main", { token: TOKEN_UNKNOWN }); // 401
    await call("/vaults/main", { token: TOKEN_AUTO }); // 403
    await call("/vaults/BAD"); // 400
    await call("/vaults/main/history/99"); // 404
    await call("/vaults/main", { method: "DELETE" }); // 405

    expect(errorBodies.length).toBeGreaterThan(5);
    for (const body of errorBodies) expect(body).not.toContain(CANARY);
    for (const spy of logSpies) {
      for (const args of spy.mock.calls) {
        expect(JSON.stringify(args)).not.toContain(CANARY);
      }
    }
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
