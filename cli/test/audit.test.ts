import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BREACH_BASE_URL, MIN_INTERVAL_MS, auditVault, resolveBreachBase, type AuditDeps } from "../src/audit.ts";
import { msg } from "../src/i18n.ts";
import { openWithKeyFile } from "../src/kdbx.ts";
import { runPwm } from "../src/pwm.ts";
import { FakeBreachFetch, BreachTable, MockBreachServer, localOnlyFetch, prefixOf, sha1Upper, suffixOf } from "./breachFixture.ts";
import { CANARY_AUTOM, hasMarker, makeCtx, makeHome, makeKdbx, registerHomeScan, type TestItem } from "./helpers.ts";

registerHomeScan();

const BASE = "http://127.0.0.1:9";
const PATHLESS_ENV = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };

// 漏洩済みとして扱う値も、目印を含む架空の値(実在のパスワードは使わない)
const PWNED_A = `${CANARY_AUTOM}-pwned-a`;
const PWNED_B = `${CANARY_AUTOM}-pwned-b`;
const CLEAN_A = `${CANARY_AUTOM}-clean-a`;
const CLEAN_B = `${CANARY_AUTOM}-clean-b`;
const APIKEY = `${CANARY_AUTOM}-apikey-1`;

function table(): BreachTable {
  const t = new BreachTable();
  t.addPwned(PWNED_A, 4321);
  t.addPwned(PWNED_B, 7);
  return t;
}

const ITEMS: TestItem[] = [
  { title: "site-pwned-a", password: PWNED_A, username: "alice", url: "https://a.example.test/" },
  { title: "site-clean-a", password: CLEAN_A },
  { title: "svc-key", password: APIKEY, type: "apikey", environment: "prod" },
  { title: "odd-type", password: `${CANARY_AUTOM}-odd`, type: "other-kind" },
  { title: "empty-pw", password: "" },
];

/** 鍵の用意された保管庫を開く(auditVault を直接呼ぶ用)。 */
async function openDb(items: TestItem[], recycleBin?: TestItem[]) {
  const h = await makeHome(items, { recycleBin });
  const { readFile } = await import("node:fs/promises");
  const bytes = new Uint8Array(await readFile(`${h.dir}/automation.kdbx`));
  return openWithKeyFile(bytes, h.keyFile);
}

function deps(fake: FakeBreachFetch, extra: Partial<AuditDeps> = {}): AuditDeps {
  return {
    baseUrl: BASE,
    fetch: fake.fetch,
    sleep: async (ms) => void fake.events.push(`sleep:${ms}`),
    ...extra,
  };
}

async function runAudit(
  items: TestItem[],
  fake: FakeBreachFetch,
  opts: { args?: string[]; lang?: "en" | "ja"; environ?: Record<string, string | undefined> } = {},
) {
  const h = await makeHome(items);
  const t = makeCtx(h.dir, {
    fetchImpl: fake.fetch,
    lang: opts.lang ?? "en",
    environ: opts.environ ?? { ...PATHLESS_ENV, PWM_BREACH_URL: BASE },
    sleep: async (ms) => void fake.events.push(`sleep:${ms}`),
  });
  const code = await runPwm(["audit", ...(opts.args ?? [])], t.ctx);
  return { code, out: t.stdout(), err: t.stderr(), dir: h.dir, ctx: t.ctx };
}

describe("1. 送る文字列", () => {
  it("URL は <基点>/range/<SHA-1 の先頭5文字(大文字の16進)> だけ。本文なし。Add-Padding: true。ハッシュの6文字目以降を含まない", async () => {
    const fake = new FakeBreachFetch(table());
    const db = await openDb([{ title: "a", password: PWNED_A }, { title: "b", password: CLEAN_A }]);
    await auditVault(db, deps(fake));
    expect(fake.calls.map((c) => c.url).sort()).toEqual([`${BASE}/range/${prefixOf(PWNED_A)}`, `${BASE}/range/${prefixOf(CLEAN_A)}`].sort());
    for (const c of fake.calls) {
      expect(c.url).toMatch(/^http:\/\/127\.0\.0\.1:9\/range\/[0-9A-F]{5}$/);
      expect(c.method).toBe("GET");
      expect(c.hasBody).toBe(false);
      expect(c.headers).toEqual({ "add-padding": "true" });
      // checkBreach は credentials/cache を渡す(拡張と同じ)。差し替えた fetch はそれを受け取る
      expect(c.init).toMatchObject({ credentials: "omit", cache: "no-store" });
      for (const pw of [PWNED_A, CLEAN_A]) {
        expect(JSON.stringify([c.url, c.headers]).includes(suffixOf(pw).slice(0, 8))).toBe(false);
        expect(JSON.stringify([c.url, c.headers]).includes(pw)).toBe(false);
      }
      expect(hasMarker(JSON.stringify([c.url, c.headers]))).toBe(false);
    }
  });

  it("PWM_BREACH_URL が無いときの基点は本番の定数(差し替えた fetch が受け取る。実 API には送らない)", async () => {
    const fake = new FakeBreachFetch(table());
    const r = await runAudit([{ title: "a", password: PWNED_A }], fake, { environ: PATHLESS_ENV });
    expect(r.code).toBe(3);
    expect(fake.calls.map((c) => c.url)).toEqual([`${BREACH_BASE_URL}/range/${prefixOf(PWNED_A)}`]);
  });
});

describe("2. 一致と不一致", () => {
  it("漏洩済みは項目名と回数、一致しない値は漏洩なし。回数 0 の行(パディング)は一致にしない", async () => {
    const t = table();
    t.addPaddingFor(CLEAN_B); // CLEAN_B の末尾が回数 0 で返る
    const fake = new FakeBreachFetch(t);
    const db = await openDb([
      { title: "pwned-a", password: PWNED_A },
      { title: "pwned-b", password: PWNED_B },
      { title: "clean-a", password: CLEAN_A },
      { title: "clean-b-padding-only", password: CLEAN_B },
    ]);
    const r = await auditVault(db, deps(fake));
    expect(r.pwned).toEqual([
      { title: "pwned-a", count: 4321 },
      { title: "pwned-b", count: 7 },
    ]);
    expect(r.clean).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.notApplicable).toBe(0);
  });

  it("標準出力の形(英語): 漏洩済みの節、集計の行。パスワード・ハッシュ・ユーザー名・URL を出さない", async () => {
    const fake = new FakeBreachFetch(table());
    const r = await runAudit(ITEMS, fake);
    expect(r.code).toBe(3);
    expect(r.out).toBe(["Pwned:", "  site-pwned-a\t4321", "Checked: 2  Pwned: 1  Clean: 1  Skipped: 0  Not applicable: 3", ""].join("\n"));
    expect(r.err).toBe("");
    for (const secret of [PWNED_A, CLEAN_A, "alice", "a.example.test", suffixOf(PWNED_A), prefixOf(PWNED_A), sha1Upper(PWNED_A)]) {
      expect((r.out + r.err).includes(secret), secret.slice(0, 6)).toBe(false);
    }
  });

  it("漏洩済みが無いときは Pwned: の節を出さない", async () => {
    const fake = new FakeBreachFetch(table());
    const r = await runAudit([{ title: "c", password: CLEAN_A }], fake);
    expect(r.out).toBe("Checked: 1  Pwned: 0  Clean: 1  Skipped: 0  Not applicable: 0\n");
    expect(r.code).toBe(0);
  });
});

describe("3. 要求の間隔と同じ先頭5文字", () => {
  it("要求を3回送る監査で、要求の間に 200ms 以上の待ちが入り、最後の要求のあとには待たない", async () => {
    const fake = new FakeBreachFetch(table());
    const db = await openDb([
      { title: "p", password: PWNED_A },
      { title: "q", password: CLEAN_A },
      { title: "r", password: CLEAN_B },
    ]);
    expect(new Set([prefixOf(PWNED_A), prefixOf(CLEAN_A), prefixOf(CLEAN_B)]).size).toBe(3);
    await auditVault(db, deps(fake));
    expect(fake.events).toEqual(["fetch", `sleep:${MIN_INTERVAL_MS}`, "fetch", `sleep:${MIN_INTERVAL_MS}`, "fetch"]);
    expect(MIN_INTERVAL_MS).toBeGreaterThanOrEqual(200);
  });

  it("対象外の項目は要求を送らず、待ちも入れない。同じ先頭5文字の項目は、要求を1回だけ送る(応答を使い回す)", async () => {
    const seen = new Map<string, string>();
    let pair: [string, string] | undefined;
    for (let i = 0; !pair; i++) {
      const p = `${CANARY_AUTOM}-pair-${i}`;
      const x = prefixOf(p);
      const o = seen.get(x);
      if (o) pair = [o, p];
      else seen.set(x, p);
    }
    const t = table();
    t.addPwned(pair[1], 9);
    const fake = new FakeBreachFetch(t);
    const db = await openDb([
      { title: "same-1", password: pair[0] },
      { title: "key", password: APIKEY, type: "apikey" },
      { title: "same-2", password: pair[1] },
      { title: "other", password: CLEAN_A },
    ]);
    const r = await auditVault(db, deps(fake));
    expect(fake.calls).toHaveLength(2); // pair の先頭5文字で1回、CLEAN_A で1回
    expect(fake.events).toEqual(["fetch", `sleep:${MIN_INTERVAL_MS}`, "fetch"]);
    expect(r.pwned).toEqual([{ title: "same-2", count: 9 }]);
    expect(r.clean).toBe(2);
    expect(r.notApplicable).toBe(1);
  });
});

describe("4. オフライン", () => {
  it("fetch が失敗するとき、応答が 500 のときは項目ごとにスキップ。漏洩なしに数えない。終了コード 2。注意の1行が付く", async () => {
    for (const mode of [{ kind: "throw" }, { kind: "status", status: 500 }] as const) {
      const fake = new FakeBreachFetch(table());
      fake.mode = mode;
      const r = await runAudit([{ title: "a", password: PWNED_A }, { title: "b", password: CLEAN_A }], fake);
      expect(r.code, mode.kind).toBe(2);
      expect(r.out).toBe(
        [
          "Checked: 2  Pwned: 0  Clean: 0  Skipped: 2  Not applicable: 0",
          "Skipped items could not be checked (offline or no usable response). They are not confirmed clean.",
          "",
        ].join("\n"),
      );
    }
  });

  it("応答が失敗した要求の結果は使い回さない(次の同じ先頭5文字の項目も、もう一度送る)", async () => {
    const fake = new FakeBreachFetch(table());
    fake.mode = { kind: "throw" };
    const db = await openDb([{ title: "a", password: CLEAN_A }, { title: "b", password: CLEAN_A }]);
    const r = await auditVault(db, deps(fake));
    expect(r.skipped).toBe(2);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("5. 対象外", () => {
  it("API キー、知らない種類、パスワードが空の項目は要求を送らず、対象外に数える。ごみ箱の中の項目は数えない", async () => {
    const fake = new FakeBreachFetch(table());
    const db = await openDb(ITEMS, [{ title: "in-bin", password: PWNED_B }]);
    const r = await auditVault(db, deps(fake));
    expect(r.notApplicable).toBe(3);
    expect(fake.calls).toHaveLength(2); // site-pwned-a と site-clean-a だけ
    expect(r.pwned).toEqual([{ title: "site-pwned-a", count: 4321 }]);
    expect(r.pwned.some((p) => p.title === "in-bin")).toBe(false);
    expect(fake.calls.some((c) => c.url.endsWith(prefixOf(PWNED_B)))).toBe(false);
    expect(fake.calls.some((c) => c.url.endsWith(prefixOf(APIKEY)))).toBe(false);
  });
});

describe("6. 終了コード", () => {
  it("全部を調べて漏洩なしは 0、漏洩なしでスキップありは 2、漏洩済みありは 3、漏洩済みとスキップの両方でも 3", async () => {
    const clean = await runAudit([{ title: "c", password: CLEAN_A }], new FakeBreachFetch(table()));
    expect(clean.code).toBe(0);

    const skipOnly = new FakeBreachFetch(table());
    skipOnly.failPrefixes.add(prefixOf(CLEAN_B));
    const s = await runAudit([{ title: "c", password: CLEAN_A }, { title: "d", password: CLEAN_B }], skipOnly);
    expect(s.code).toBe(2);

    const pwned = await runAudit([{ title: "p", password: PWNED_A }], new FakeBreachFetch(table()));
    expect(pwned.code).toBe(3);

    const both = new FakeBreachFetch(table());
    both.failPrefixes.add(prefixOf(CLEAN_B));
    const b = await runAudit([{ title: "p", password: PWNED_A }, { title: "d", password: CLEAN_B }], both);
    expect(b.code).toBe(3);
    expect(b.out).toContain("Pwned: 1");
    expect(b.out).toContain("Skipped: 1");
  });

  it("保管庫が無いときは 1(標準出力は空)", async () => {
    const dir = (await makeHome([])).dir;
    const { rm } = await import("node:fs/promises");
    await rm(`${dir}/automation.kdbx`);
    const t = makeCtx(dir, { fetchImpl: new FakeBreachFetch(table()).fetch, environ: { ...PATHLESS_ENV, PWM_BREACH_URL: BASE } });
    expect(await runPwm(["audit"], t.ctx)).toBe(1);
    expect(t.stdout()).toBe("");
    expect(t.stderr()).toContain("automation vault");
  });
});

describe("11. PWM_BREACH_URL", () => {
  it("http://127.0.0.1:<ポート> と http://localhost:<ポート> は受け付ける", () => {
    expect(resolveBreachBase({ PWM_BREACH_URL: "http://127.0.0.1:8123" })).toBe("http://127.0.0.1:8123");
    expect(resolveBreachBase({ PWM_BREACH_URL: "http://localhost:8123" })).toBe("http://localhost:8123");
    expect(resolveBreachBase({})).toBe(BREACH_BASE_URL);
  });

  it("https://example.com、http://192.168.0.1:80、パス付きなどはエラーで止まり、要求を送らない。文言に与えられた値を入れない", async () => {
    const bad = [
      "https://example.com",
      "http://192.168.0.1:80",
      "http://127.0.0.1:8123/",
      "http://127.0.0.1:8123/range",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:99999",
      "https://127.0.0.1:8123",
      "http://127.0.0.1.evil.example:8123",
      "http://user@127.0.0.1:8123",
      "http://localhost:8123?x=1",
      "",
    ];
    for (const value of bad) {
      expect(() => resolveBreachBase({ PWM_BREACH_URL: value }), value).toThrow();
      const fake = new FakeBreachFetch(table());
      const r = await runAudit([{ title: "p", password: PWNED_A }], fake, { environ: { ...PATHLESS_ENV, PWM_BREACH_URL: value } });
      expect(r.code, value).toBe(1);
      expect(fake.calls, value).toHaveLength(0);
      expect(r.out).toBe("");
      expect(r.err).toContain("PWM_BREACH_URL");
      // 固定の文言(http://127.0.0.1:PORT の案内を含む)を除いたあとに、与えられた値が残らない
      if (value) expect(r.err.replaceAll(msg("en", "badBreachUrl"), "").includes(value)).toBe(false);
    }
  });
});

describe("13. 文言", () => {
  it("PWM_LANG に当たる lang で、日本語と英語が切り替わる", async () => {
    const mk = () => {
      const f = new FakeBreachFetch(table());
      f.failPrefixes.add(prefixOf(CLEAN_B));
      return f;
    };
    const items = [{ title: "p", password: PWNED_A }, { title: "d", password: CLEAN_B }];
    const ja = await runAudit(items, mk(), { lang: "ja" });
    expect(ja.out).toContain("漏洩済み:");
    expect(ja.out).toContain("確認: 2  漏洩済み: 1  漏洩なし: 0  スキップ: 1  対象外: 0");
    expect(ja.out).toContain("漏洩なしではありません");
    const en = await runAudit(items, mk(), { lang: "en" });
    expect(en.out).toContain("Pwned:");
    expect(en.out).toContain("not confirmed clean");
    // 環境変数での切り替え
    const { detectLang } = await import("../src/i18n.ts");
    expect(detectLang({ PWM_LANG: "ja" })).toBe("ja");
    expect(detectLang({ PWM_LANG: "en" })).toBe("en");
  });
});

describe("実際の Node の fetch とローカルのモックサーバー(checkBreach の credentials/cache の設定)", () => {
  it("Node の fetch が checkBreach の要求の設定を受け付け、モックサーバーに /range/<5文字> と Add-Padding だけが届く", async () => {
    const t = table();
    const server = new MockBreachServer(t);
    await server.start();
    try {
      const h = await makeHome([{ title: "p", password: PWNED_A }, { title: "c", password: CLEAN_A }]);
      const ctx = makeCtx(h.dir, { fetchImpl: localOnlyFetch, environ: { ...PATHLESS_ENV, PWM_BREACH_URL: server.url } });
      const code = await runPwm(["audit"], ctx.ctx);
      expect(ctx.stdout()).toContain("p\t4321");
      expect(ctx.stdout()).toContain("Skipped: 0"); // fetch が設定を受け付けずに例外になると、全部スキップになる
      expect(code).toBe(3);
      expect(server.requests.map((r) => r.path).sort()).toEqual([`/range/${prefixOf(PWNED_A)}`, `/range/${prefixOf(CLEAN_A)}`].sort());
      for (const r of server.requests) {
        expect(r.method).toBe("GET");
        expect(r.bodyLength).toBe(0);
        expect(r.headers["add-padding"]).toBe("true");
        expect(r.headers.authorization).toBeUndefined();
        expect(r.headers.cookie).toBeUndefined();
        expect(hasMarker(JSON.stringify(r))).toBe(false);
        for (const pw of [PWNED_A, CLEAN_A]) expect(JSON.stringify(r).includes(suffixOf(pw).slice(0, 6))).toBe(false);
      }
    } finally {
      await server.stop();
    }
  });
});

describe("17. カナリア(pwm audit の出力と PWM_HOME)", () => {
  it("漏洩あり・なし・スキップ・エラーのすべての標準出力と標準エラーに目印もハッシュも出ない。PWM_HOME に新しいファイルができない", async () => {
    const h = await makeHome(ITEMS);
    const before = (await readdir(h.dir)).sort();
    const texts: string[] = [];
    const cases: { name: string; fake: FakeBreachFetch; environ?: Record<string, string | undefined> }[] = [
      { name: "pwned", fake: new FakeBreachFetch(table()) },
      { name: "offline", fake: Object.assign(new FakeBreachFetch(table()), { mode: { kind: "throw" } as const }) },
      { name: "500", fake: Object.assign(new FakeBreachFetch(table()), { mode: { kind: "status", status: 500 } as const }) },
      { name: "bad-url", fake: new FakeBreachFetch(table()), environ: { ...PATHLESS_ENV, PWM_BREACH_URL: "https://example.com" } },
    ];
    for (const c of cases) {
      for (const lang of ["en", "ja"] as const) {
        const t = makeCtx(h.dir, {
          fetchImpl: c.fake.fetch,
          lang,
          environ: c.environ ?? { ...PATHLESS_ENV, PWM_BREACH_URL: BASE },
        });
        await runPwm(["audit"], t.ctx);
        texts.push(t.stdout(), t.stderr());
        for (const call of c.fake.calls) texts.push(call.url, JSON.stringify(call.headers));
      }
    }
    // 保管庫が無い・開けないエラー
    const nope = makeCtx((await makeHome([])).dir, { fetchImpl: new FakeBreachFetch(table()).fetch, environ: { ...PATHLESS_ENV, PWM_BREACH_URL: BASE } });
    await runPwm(["audit", "--bogus"], nope.ctx);
    texts.push(nope.stdout(), nope.stderr());
    for (const text of texts) {
      expect(hasMarker(text)).toBe(false);
      for (const pw of [PWNED_A, CLEAN_A, APIKEY]) {
        expect(text.includes(sha1Upper(pw))).toBe(false);
        expect(text.includes(suffixOf(pw).slice(0, 6))).toBe(false);
      }
      expect(text.includes("alice")).toBe(false);
      expect(text.includes("a.example.test")).toBe(false);
    }
    expect((await readdir(h.dir)).sort()).toEqual(before); // 監査は何も保存しない
  });
});

describe("18. 失敗の表示", () => {
  it("知らない引数、保管庫が開けない失敗に、パスワード・ハッシュ・ユーザー名・URL が入らない", async () => {
    const h = await makeHome([{ title: "p", password: PWNED_A, username: "alice", url: "https://a.example.test/" }]);
    const fake = new FakeBreachFetch(table());
    // 保管庫を本体の暗号文に差し替えると開けない
    const wrong = await makeKdbx({ master: "m" }, [{ title: "x", password: PWNED_B }]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${h.dir}/automation.kdbx`, wrong);
    for (const args of [["--token=abc"], [], ["--main-x"]]) {
      const t = makeCtx(h.dir, { fetchImpl: fake.fetch, environ: { ...PATHLESS_ENV, PWM_BREACH_URL: BASE } });
      const code = await runPwm(["audit", ...args], t.ctx);
      expect(code).not.toBe(0);
      const text = t.stdout() + t.stderr();
      for (const bad of [PWNED_A, PWNED_B, "alice", "a.example.test", sha1Upper(PWNED_A), suffixOf(PWNED_A), "abc"]) {
        expect(text.includes(bad), bad.slice(0, 5)).toBe(false);
      }
    }
    expect(fake.calls).toHaveLength(0);
  });
});
