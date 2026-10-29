import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenVault } from "../../extension/src/shared/vault.ts";
import { runPwm } from "../src/pwm.ts";
import { FILES } from "../src/store.ts";
import { BreachTable, FakeBreachFetch, prefixOf, sha1Upper, suffixOf } from "./breachFixture.ts";
import { MockSync } from "./mockSync.ts";
import { CANARY_AUTOM, CANARY_MAIN, MASTER, hasMarker, makeCtx, makeHome, makeKdbx, registerHomeScan, tmpHome } from "./helpers.ts";

registerHomeScan();

const BASE = "http://127.0.0.1:9";
const ENV = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PWM_BREACH_URL: BASE };
const PWNED_1 = `${CANARY_AUTOM}-notify-pwned-1`;
const PWNED_2 = `${CANARY_AUTOM}-notify-pwned-2`;
const CLEAN = `${CANARY_AUTOM}-notify-clean`;
const OFFLINE = `${CANARY_AUTOM}-notify-offline`;

function table(): BreachTable {
  const t = new BreachTable();
  t.addPwned(PWNED_1, 11);
  t.addPwned(PWNED_2, 22);
  return t;
}

async function audit(
  items: { title: string; password: string }[],
  args: string[],
  opts: { fake?: FakeBreachFetch; lang?: "en" | "ja"; notify?: (text: string) => Promise<void> } = {},
) {
  const fake = opts.fake ?? new FakeBreachFetch(table());
  const h = await makeHome(items);
  const t = makeCtx(h.dir, { fetchImpl: fake.fetch, environ: ENV, lang: opts.lang ?? "en", notify: opts.notify });
  const code = await runPwm(["audit", ...args], t.ctx);
  return { code, out: t.stdout(), err: t.stderr(), notified: t.notified, fake };
}

describe("7. pwm audit --notify", () => {
  const pwned = [
    { title: "secret-site-name-1", password: PWNED_1 },
    { title: "secret-site-name-2", password: PWNED_2 },
    { title: "ok", password: CLEAN },
  ];

  it("漏洩済みのときだけ通知を1回出す。文言は件数だけで、項目名・値・回数を入れない", async () => {
    const r = await audit(pwned, ["--notify"]);
    expect(r.code).toBe(3);
    expect(r.notified).toEqual(["pwm: 2 password(s) found in known breaches"]);
    for (const text of r.notified) {
      expect(text.includes("secret-site-name")).toBe(false);
      expect(text.includes("11") || text.includes("22")).toBe(false);
      expect(hasMarker(text)).toBe(false);
      expect(text.includes(suffixOf(PWNED_1).slice(0, 6))).toBe(false);
    }
    const ja = await audit(pwned, ["--notify"], { lang: "ja" });
    expect(ja.notified).toEqual(["pwm: 2 件のパスワードが漏洩済みです"]);
  });

  it("漏洩なし・スキップだけのとき、--notify を付けないときは通知を出さない", async () => {
    const clean = await audit([{ title: "ok", password: CLEAN }], ["--notify"]);
    expect(clean.code).toBe(0);
    expect(clean.notified).toEqual([]);

    const fake = new FakeBreachFetch(table());
    fake.mode = { kind: "throw" };
    const skipped = await audit([{ title: "off", password: OFFLINE }, { title: "p", password: PWNED_1 }], ["--notify"], { fake });
    expect(skipped.code).toBe(2);
    expect(skipped.notified).toEqual([]);

    const noFlag = await audit(pwned, []);
    expect(noFlag.code).toBe(3);
    expect(noFlag.notified).toEqual([]);
  });

  it("漏洩済みとスキップの両方でも、漏洩済みがあれば通知を1回出す(終了コード 3)", async () => {
    const fake = new FakeBreachFetch(table());
    fake.failPrefixes.add(prefixOf(OFFLINE));
    const r = await audit([{ title: "p", password: PWNED_1 }, { title: "off", password: OFFLINE }], ["--notify"], { fake });
    expect(r.code).toBe(3);
    expect(r.notified).toEqual(["pwm: 1 password(s) found in known breaches"]);
  });

  it("通知に失敗しても、標準出力と終了コードは変わらない。標準エラーに「通知を出せませんでした」とだけ出す", async () => {
    const ok = await audit(pwned, ["--notify"]);
    const failing = await audit(pwned, ["--notify"], {
      notify: async () => {
        throw new Error(`boom ${PWNED_1}`);
      },
    });
    expect(failing.code).toBe(ok.code);
    expect(failing.out).toBe(ok.out);
    expect(failing.err).toBe("Could not show the notification.\n");
    const ja = await audit(pwned, ["--notify"], {
      lang: "ja",
      notify: async () => {
        throw new Error("boom");
      },
    });
    expect(ja.err).toBe("通知を出せませんでした。\n");
    expect(hasMarker(failing.out + failing.err + ja.err)).toBe(false);
  });
});

describe("8. pwm audit --main", () => {
  const mock = new MockSync();
  beforeAll(async () => void (await mock.start()));
  afterAll(() => mock.stop());

  const MAIN_PWNED = `${CANARY_MAIN}-main-pwned`;
  const MAIN_CLEAN = `${CANARY_MAIN}-main-clean`;

  async function mainHome() {
    const dir = await tmpHome();
    const tokenMain = `${CANARY_MAIN}-audit-main-token`;
    mock.tokens.set(tokenMain, "main");
    mock.setVault(
      "main",
      await makeKdbx({ master: MASTER }, [
        { title: "main-site", password: MAIN_PWNED },
        { title: "main-other", password: MAIN_CLEAN },
      ]),
    );
    await writeFile(path.join(dir, "main.token.kdbx"), await createTokenVault(MASTER, tokenMain));
    await writeFile(path.join(dir, FILES.config), JSON.stringify({ syncUrl: mock.url, mainVault: "main" }));
    return dir;
  }

  // 同期先のモックは本物の fetch で、漏洩チェックの先(/range/)は差し替えた fetch でつなぐ
  const routed = (fake: FakeBreachFetch): typeof fetch => (input, init) =>
    String(input).includes("/range/") ? fake.fetch(input, init) : fetch(input, init);

  it("端末のときだけ受け付け、マスターパスワードを聞いて本体の保管庫の項目を調べる。自動処理用の保管庫は調べない", async () => {
    const dir = await mainHome();
    const t2 = new BreachTable();
    t2.addPwned(MAIN_PWNED, 99);
    const fake = new FakeBreachFetch(t2);
    const t = makeCtx(dir, { fetchImpl: routed(fake), environ: ENV, answers: [MASTER] });
    const code = await runPwm(["audit", "--main"], t.ctx);
    expect(code).toBe(3);
    expect(t.stdout()).toBe("Pwned:\n  main-site\t99\nChecked: 2  Pwned: 1  Clean: 1  Skipped: 0  Not applicable: 0\n");
    expect(t.asked).toHaveLength(1);
    expect(fake.calls.map((c) => c.url).sort()).toEqual([`${BASE}/range/${prefixOf(MAIN_PWNED)}`, `${BASE}/range/${prefixOf(MAIN_CLEAN)}`].sort());
    for (const text of [t.stdout(), t.stderr()]) {
      expect(hasMarker(text)).toBe(false);
      expect(text.includes(sha1Upper(MAIN_PWNED))).toBe(false);
    }
  });

  it("端末でないときは何もしない(聞かない、通信しない、要求を送らない)。PWM_BREACH_URL の誤りはマスターパスワードを聞く前に止まる", async () => {
    const dir = await mainHome();
    const fake = new FakeBreachFetch(table());
    const before = mock.requests.length;
    const notTty = makeCtx(dir, { tty: false, fetchImpl: routed(fake), environ: ENV, answers: [MASTER] });
    expect(await runPwm(["audit", "--main"], notTty.ctx)).toBe(1);
    expect(notTty.asked).toEqual([]);
    expect(notTty.stdout()).toBe("");
    expect(notTty.stderr()).toContain("terminal");

    const badUrl = makeCtx(dir, { fetchImpl: routed(fake), environ: { ...ENV, PWM_BREACH_URL: "https://example.com" }, answers: [MASTER] });
    expect(await runPwm(["audit", "--main"], badUrl.ctx)).toBe(1);
    expect(badUrl.asked).toEqual([]);

    expect(mock.requests.length).toBe(before);
    expect(fake.calls).toHaveLength(0);
  });

  it("マスターパスワードが違うときは、何も調べず何も出さない。本体の保管庫の目印を出さない", async () => {
    const dir = await mainHome();
    const fake = new FakeBreachFetch(table());
    const t = makeCtx(dir, { fetchImpl: routed(fake), environ: ENV, answers: ["wrong-master"] });
    expect(await runPwm(["audit", "--main"], t.ctx)).toBe(1);
    expect(t.stdout()).toBe("");
    expect(fake.calls).toHaveLength(0);
    expect(hasMarker(t.stderr())).toBe(false);
  });
});

describe("--main なしは、ローカルの automation.kdbx だけを読む(同期しない)", () => {
  it("同期先の fetch は呼ばれない(漏洩チェックの要求だけ)", async () => {
    const h = await makeHome([{ title: "a", password: CLEAN }], { token: "t", syncUrl: "http://127.0.0.1:9", vault: "automation" });
    const fake = new FakeBreachFetch(table());
    const t = makeCtx(h.dir, { fetchImpl: fake.fetch, environ: ENV });
    expect(await runPwm(["audit"], t.ctx)).toBe(0);
    expect(fake.calls.every((c) => c.url.includes("/range/"))).toBe(true);
  });
});
