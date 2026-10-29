import { describe, expect, it } from "vitest";
import { handleFill, type ApprovalAsk, type FillDeps, type FillRequest, type FillResult, type FillTarget } from "../src/background/fill.ts";
import type { Session } from "../src/shared/storage.ts";
import type { VaultItem } from "../src/shared/vault.ts";
import { CANARY } from "./canary.ts";

// 4-1 の 13・14: request_fill の分かれ方(設計書 §11-3、実装指示_フェーズ5 の 3-5)。外とのつながりは差し替える。
const ORIGIN = "http://app.localhost:18701";
const PW = `${CANARY}-fill-pw`;
const item = (over: Partial<VaultItem> = {}): VaultItem => ({
  id: "id-app",
  title: "App Login",
  username: "app-user",
  password: PW,
  url: ORIGIN,
  itemType: "",
  ...over,
});
const session = (items: VaultItem[]): Session => ({ items, expiresAt: Date.now() + 3600_000, source: "server" });

interface World {
  session: Session | null;
  /** getTarget が返す値を順番に。最後のものを使い続ける */
  targets: (FillTarget | null)[];
  approved: Set<string>;
  answer: boolean;
  fillOk: boolean;
  /** 承認画面が出ている間に起きること(ロックされる、項目が変わるなど) */
  duringApproval?: () => void;
}

function make(world: Partial<World> = {}) {
  const w: World = {
    session: session([item()]),
    targets: [{ tabId: 7, origin: ORIGIN }],
    approved: new Set(),
    answer: true,
    fillOk: true,
    ...world,
  };
  let targetCalls = 0;
  const log = {
    asked: [] as ApprovalAsk[],
    filled: [] as { tabId: number; origin: string; username: string; password: string }[],
    added: [] as string[],
  };
  const deps: FillDeps = {
    getSession: async () => w.session,
    getTarget: async () => w.targets[Math.min(targetCalls++, w.targets.length - 1)] ?? null,
    isApproved: async (o) => w.approved.has(o),
    addApproval: async (o) => void log.added.push(o),
    askApproval: async (a) => {
      log.asked.push(a);
      w.duringApproval?.();
      return w.answer;
    },
    fillTab: async (tabId, origin, username, password) => {
      log.filled.push({ tabId, origin, username, password });
      return w.fillOk;
    },
  };
  const run = (req: Partial<FillRequest> = {}): Promise<FillResult> => handleFill(deps, { id: "i", title: "App Login", client: "ai", ...req });
  return { w, log, run };
}

describe("request_fill の分かれ方", () => {
  it("承認済みのオリジン: 承認画面なしで入力して filled。承認リストに足し直さない", async () => {
    const m = make({ approved: new Set([ORIGIN]) });
    expect(await m.run()).toBe("filled");
    expect(m.log.asked).toHaveLength(0);
    expect(m.log.filled).toEqual([{ tabId: 7, origin: ORIGIN, username: "app-user", password: PW }]);
    expect(m.log.added).toEqual([]);
  });

  it("未承認のオリジン: 承認画面を出す(オリジン・項目名・ユーザー名の一部・AI の名前)。承認なら入力して承認リストに足し filled", async () => {
    const m = make();
    expect(await m.run({ client: "my-ai" })).toBe("filled");
    expect(m.log.asked).toEqual([{ origin: ORIGIN, title: "App Login", userHint: "ap…", client: "my-ai", tabId: 7 }]);
    expect(JSON.stringify(m.log.asked)).not.toContain(PW); // 承認画面に値は渡らない
    expect(m.log.filled).toHaveLength(1);
    expect(m.log.added).toEqual([ORIGIN]);
  });

  it("未承認のオリジンで拒否・時間切れ・窓を閉じた(askApproval が false): 入力せず denied。承認リストに足さない", async () => {
    const m = make({ answer: false });
    expect(await m.run()).toBe("denied");
    expect(m.log.filled).toEqual([]);
    expect(m.log.added).toEqual([]);
  });

  it("ロック中: locked(承認画面も出さない)", async () => {
    const m = make({ session: null });
    expect(await m.run()).toBe("locked");
    expect(m.log.asked).toHaveLength(0);
    expect(m.log.filled).toEqual([]);
  });

  it("項目名が一致しない、そのオリジンに合う項目が無い、同じ項目名が2件: not_found", async () => {
    const cases: [string, ReturnType<typeof make>, Partial<FillRequest>][] = [
      ["項目名違い", make(), { title: "Other" }],
      ["オリジン違い", make({ session: session([item({ url: "http://other.localhost:18701" })]) }), {}],
      ["2件", make({ session: session([item(), item({ id: "id-2", username: "x" })]) }), {}],
    ];
    for (const [label, m, req] of cases) {
      expect(await m.run(req), label).toBe("not_found");
      expect(m.log.asked, label).toHaveLength(0);
      expect(m.log.filled, label).toEqual([]);
    }
  });

  it("API キーの項目・知らない種類の項目は、オリジンが合っても not_found(承認画面も出さない)", async () => {
    for (const itemType of ["apikey", "securenote", "unknown-type"]) {
      const m = make({ session: session([item({ itemType })]), approved: new Set([ORIGIN]) });
      expect(await m.run(), itemType).toBe("not_found");
      expect(m.log.filled).toEqual([]);
      expect(m.log.asked).toEqual([]);
    }
    // 種類が password と明示されているものは入力する
    const m = make({ session: session([item({ itemType: "password" })]), approved: new Set([ORIGIN]) });
    expect(await m.run()).toBe("filled");
  });

  it("AI が渡した URL が実際のタブのオリジンと違う: 入力せず not_found(AI の URL に合う項目があっても、実際のタブで照合する)", async () => {
    const fake = "https://fake.example.test";
    const m = make({
      session: session([item(), item({ id: "id-fake", title: "App Login", url: fake, username: "fake-user" })]),
      approved: new Set([ORIGIN, fake]),
    });
    expect(await m.run({ url: fake })).toBe("not_found");
    expect(m.log.filled).toEqual([]);
    expect(m.log.asked).toEqual([]);
    // 実際のタブと同じオリジンの URL(パス付き)なら進む。URL を渡さなくても進む
    expect(await m.run({ url: `${ORIGIN}/login.html?x=1` })).toBe("filled");
    expect(m.log.filled.map((f) => f.username)).toEqual(["app-user"]);
    expect(await m.run()).toBe("filled");
    // URL が読めないときも入力しない
    expect(await m.run({ url: "http://" })).toBe("not_found");
  });

  it("実際のタブのオリジンが保存したものと違う(ポート違い、サブドメイン違い)、入力してよいページでない(target が null): not_found", async () => {
    for (const origin of ["http://app.localhost:18702", "http://sub.app.localhost:18701", "http://app2.localhost:18701"]) {
      const m = make({ targets: [{ tabId: 7, origin }], approved: new Set([origin]) });
      expect(await m.run(), origin).toBe("not_found");
      expect(m.log.filled).toEqual([]);
    }
    const none = make({ targets: [null] });
    expect(await none.run()).toBe("not_found");
  });

  it("入れる欄が無い(fillTab が false): not_found。承認リストに足さない", async () => {
    const m = make({ fillOk: false });
    expect(await m.run()).toBe("not_found");
    expect(m.log.asked).toHaveLength(1);
    expect(m.log.added).toEqual([]);
  });

  it("承認したあと、タブが変わっていたら入力せず not_found。承認リストにも足さない", async () => {
    const m = make({
      targets: [
        { tabId: 7, origin: ORIGIN },
        { tabId: 8, origin: ORIGIN },
      ],
    });
    expect(await m.run()).toBe("not_found");
    expect(m.log.filled).toEqual([]);
    expect(m.log.added).toEqual([]);
  });

  it("承認したあと、同じタブでもオリジンが変わっていたら入力せず not_found(別のページに移った)", async () => {
    const nexts: (FillTarget | null)[] = [
      { tabId: 7, origin: "http://app.localhost:18702" },
      { tabId: 7, origin: "http://evil.localhost:18701" },
      null,
    ];
    for (const next of nexts) {
      const m = make({ targets: [{ tabId: 7, origin: ORIGIN }, next] });
      expect(await m.run()).toBe("not_found");
      expect(m.log.filled).toEqual([]);
      expect(m.log.added).toEqual([]);
    }
  });

  it("承認の待ちのあいだにロックされた、項目が変わった: 入力しない(locked、not_found)。値は最新のものを使う", async () => {
    const locked = make();
    locked.w.duringApproval = () => void (locked.w.session = null);
    expect(await locked.run()).toBe("locked");
    expect(locked.log.filled).toEqual([]);
    expect(locked.log.added).toEqual([]);

    const removed = make();
    removed.w.duringApproval = () => void (removed.w.session = session([]));
    expect(await removed.run()).toBe("not_found");
    expect(removed.log.filled).toEqual([]);

    const changed = make();
    changed.w.duringApproval = () => void (changed.w.session = session([item({ password: `${PW}-new` })]));
    expect(await changed.run()).toBe("filled");
    expect(changed.log.filled[0]!.password).toBe(`${PW}-new`);

    const typeChanged = make();
    typeChanged.w.duringApproval = () => void (typeChanged.w.session = session([item({ itemType: "apikey" })]));
    expect(await typeChanged.run()).toBe("not_found");
    expect(typeChanged.log.filled).toEqual([]);
  });

  it("どこかで例外になったら unavailable(値を含まない)", async () => {
    const deps: FillDeps = {
      getSession: async () => {
        throw new Error(`boom ${PW}`);
      },
      getTarget: async () => null,
      isApproved: async () => false,
      addApproval: async () => undefined,
      askApproval: async () => false,
      fillTab: async () => false,
    };
    const r = await handleFill(deps, { id: "i", title: "t", client: "c" });
    expect(r).toBe("unavailable");
  });

  it("AI に返る結果は語だけ(値、ユーザー名、オリジンを含まない)", async () => {
    const m = make();
    const r = await m.run();
    expect(["filled", "denied", "not_found", "locked", "unavailable"]).toContain(r);
    expect(JSON.stringify(r)).not.toContain(PW);
  });
});
