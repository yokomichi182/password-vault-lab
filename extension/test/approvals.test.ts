import { beforeEach, describe, expect, it } from "vitest";
import { APPROVALS_KEY, addApproval, isApproved, listApprovals, removeApproval, sanitizeApprovals } from "../src/shared/approvals.ts";

// chrome.storage.local の最小の代用品
function installChrome(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string) {
          return store.has(key) ? { [key]: store.get(key) } : {};
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
    },
  };
  return store;
}

describe("承認リスト", () => {
  let store: Map<string, unknown>;
  beforeEach(() => {
    store = installChrome();
  });

  it("追加・照合・削除。1件はオリジンと時刻だけで、項目名やユーザー名は入らない", async () => {
    expect(await listApprovals()).toEqual([]);
    await addApproval("http://app.localhost:18701", new Date("2026-10-29T00:00:00Z"));
    await addApproval("https://shop.example.test");
    expect(await isApproved("http://app.localhost:18701")).toBe(true);
    expect(await isApproved("https://shop.example.test")).toBe(true);
    const saved = store.get(APPROVALS_KEY) as { origin: string; at: string }[];
    expect(saved).toHaveLength(2);
    for (const e of saved) expect(Object.keys(e).sort()).toEqual(["at", "origin"]);
    expect(saved[0]).toEqual({ origin: "http://app.localhost:18701", at: "2026-10-29T00:00:00.000Z" });
    await removeApproval("http://app.localhost:18701");
    expect(await isApproved("http://app.localhost:18701")).toBe(false);
    expect(await isApproved("https://shop.example.test")).toBe(true);
    // 無いものを消しても何も起きない
    await removeApproval("https://nothing.example.test");
    expect((await listApprovals()).map((a) => a.origin)).toEqual(["https://shop.example.test"]);
  });

  it("照合はオリジンの完全一致: ポート違い、サブドメイン違い、スキーム違い、似た名前は別のオリジン", async () => {
    await addApproval("https://example.test");
    await addApproval("http://app.localhost:18701");
    for (const other of [
      "https://example.test:8443", // ポート違い
      "http://example.test", // スキーム違い
      "https://sub.example.test", // サブドメイン違い
      "https://example.test.evil.test", // 前方一致
      "https://xexample.test", // 後方一致
      "http://app.localhost:18702",
      "http://app.localhost",
      "http://sub.app.localhost:18701",
      "not a url",
      "",
    ]) {
      expect(await isApproved(other), other).toBe(false);
    }
    // 同じオリジンの別の書き方(パス付き・既定ポート・大文字のホスト)は同じ扱い
    expect(await isApproved("https://EXAMPLE.test/login?x=1")).toBe(true);
    expect(await isApproved("https://example.test:443")).toBe(true);
    // 同じオリジンを2回足しても1件
    await addApproval("https://example.test/other");
    expect(await listApprovals()).toHaveLength(2);
  });

  it("入力してよいオリジンでないものは足せない(http の 127.0.0.1、file:、chrome-extension:)", async () => {
    for (const bad of ["http://127.0.0.1:8080", "http://example.test", "file:///c:/x", "chrome-extension://abc/", "nonsense"]) {
      await expect(addApproval(bad), bad).rejects.toThrow();
    }
    expect(await listApprovals()).toEqual([]);
  });

  it("保存された中身が壊れていても読める: 形が違うもの、正規でないオリジン、重複は捨てる", () => {
    expect(sanitizeApprovals("x")).toEqual([]);
    expect(sanitizeApprovals(null)).toEqual([]);
    expect(
      sanitizeApprovals([
        { origin: "https://a.example.test", at: "t1" },
        { origin: "https://a.example.test", at: "t2" }, // 重複
        { origin: "https://A.example.test/path", at: "t3" }, // 正規の形でない
        { origin: "http://127.0.0.1:1", at: "t4" },
        { origin: 5, at: "t5" },
        { origin: "https://b.example.test" },
        null,
        "x",
        { origin: "https://c.example.test", at: "t6", title: "should not be kept", username: "u" },
      ]),
    ).toEqual([
      { origin: "https://a.example.test", at: "t1" },
      { origin: "https://c.example.test", at: "t6" },
    ]);
  });
});
