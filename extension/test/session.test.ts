import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clampHours, clearSession, getSession, setSession } from "../src/shared/storage.ts";
import { CANARY } from "./canary.ts";

// chrome.storage.session と chrome.alarms の最小の代用品
function installChrome() {
  const store = new Map<string, unknown>();
  const alarms = new Map<string, number>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        async get(key: string) {
          return store.has(key) ? { [key]: store.get(key) } : {};
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        async clear() {
          store.clear();
        },
      },
    },
    alarms: {
      async create(name: string, info: { when: number }) {
        alarms.set(name, info.when);
      },
      async clear(name: string) {
        return alarms.delete(name);
      },
    },
  };
  return { store, alarms };
}

describe("セッション", () => {
  let env: ReturnType<typeof installChrome>;
  beforeEach(() => {
    env = installChrome();
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const item = { id: "1", title: "t", username: "u", password: `${CANARY}-p`, url: "https://a.example.test", itemType: "" };

  it("期限の前は返し、alarm を期限に合わせる。マスターパスワードやトークンの欄は持たない", async () => {
    await setSession({ items: [item], expiresAt: 5000, source: "server" });
    expect(env.alarms.get("session-expire")).toBe(5000);
    expect((await getSession(4999))?.items).toHaveLength(1);
    expect(Object.keys(env.store)).toEqual([]);
    expect([...env.store.keys()]).toEqual(["session"]);
    const raw = JSON.stringify(env.store.get("session"));
    expect(raw).not.toMatch(/master|token|compositeKey/i);
  });

  it("期限を過ぎたら(alarm が遅れていても)空にして null を返す", async () => {
    await setSession({ items: [item], expiresAt: 5000, source: "server" });
    expect(await getSession(5000)).toBeNull();
    expect(env.store.size).toBe(0);
    expect(env.alarms.size).toBe(0);
  });

  it("ロックで空になる", async () => {
    await setSession({ items: [item], expiresAt: 5000, source: "server" });
    await clearSession();
    expect(await getSession(1)).toBeNull();
  });

  it("セッションの長さは 1〜24 時間に収める", () => {
    expect(clampHours(0)).toBe(1);
    expect(clampHours(100)).toBe(24);
    expect(clampHours(8)).toBe(8);
    expect(clampHours(Number.NaN)).toBe(8);
  });
});
