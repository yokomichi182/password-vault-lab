import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveEntries, openWithKeyFile } from "../src/kdbx.ts";
import { runPwm } from "../src/pwm.ts";
import { FILES } from "../src/store.ts";
import { BreachTable, FakeBreachFetch, prefixOf, sha1Upper, suffixOf } from "./breachFixture.ts";
import { MockSync } from "./mockSync.ts";
import { CANARY_AUTOM, hasMarker, makeCtx, makeHome, registerHomeScan } from "./helpers.ts";

registerHomeScan();

// 9. auto add と auto update --value のあとの、1回だけの漏洩チェック(設計書 §14-3)
const TOKEN = `${CANARY_AUTOM}-tok-postsave`;
const BREACH_BASE = "http://127.0.0.1:9";
const PWNED_PW = `${CANARY_AUTOM}-pwned-after-save`;
const CLEAN_PW = `${CANARY_AUTOM}-clean-after-save`;

const table = new BreachTable();
table.addPwned(PWNED_PW, 4321);
const breach = new FakeBreachFetch(table);

// 漏洩チェックの先(/range/)は差し替えた fetch。同期先のモックだけ本物の fetch でつなぐ(実 API には届かない)
const routedFetch: typeof fetch = (input, init) => (String(input).includes("/range/") ? breach.fetch(input, init) : fetch(input, init));
const ENVIRON = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PWM_BREACH_URL: BREACH_BASE };

const mock = new MockSync();
beforeAll(async () => void (await mock.start()));
afterAll(() => mock.stop());

let seq = 0;
async function seeded() {
  seq += 1;
  const vault = `ps${seq}`;
  mock.tokens.set(TOKEN, vault);
  const home = await makeHome([{ title: "seed", password: `${CANARY_AUTOM}-seed` }], { token: TOKEN, syncUrl: mock.url, vault });
  mock.setVault(vault, new Uint8Array(await readFile(path.join(home.dir, FILES.automationKdbx))));
  return { vault, home };
}

function reset(): void {
  breach.calls = [];
  breach.events = [];
  breach.mode = { kind: "ok" };
  breach.failPrefixes.clear();
}

const run = async (home: string, argv: string[], opts: Parameters<typeof makeCtx>[1] = {}) => {
  const t = makeCtx(home, { fetchImpl: routedFetch, environ: ENVIRON, ...opts });
  const code = await runPwm(argv, t.ctx);
  return { code, out: t.stdout(), err: t.stderr() };
};

describe("9. 保存のあとの1回の漏洩チェック", () => {
  it("auto add(パスワード)のあと、その項目だけ要求を1回送る。漏洩済みでも保存は残り、終了コードは 0。標準エラーに回数だけ出す", async () => {
    reset();
    const { vault, home } = await seeded();
    const r = await run(home.dir, ["auto", "add", "--title", "fresh"], { answers: [PWNED_PW, PWNED_PW] });
    expect(r.code).toBe(0);
    expect(r.out).toBe("Saved.\n");
    expect(r.err).toBe("This value has appeared in known breaches (4321 times). Use a different value.\n");
    expect(breach.calls.map((c) => c.url)).toEqual([`${BREACH_BASE}/range/${prefixOf(PWNED_PW)}`]);
    expect(breach.calls[0]!.headers).toEqual({ "add-padding": "true" });
    // 保存は取り消されない(同期先にも、手元にも残る)
    const server = await openWithKeyFile(mock.vaults.get(vault)!.bytes, home.keyFile);
    expect(liveEntries(server).map((x) => x.fields.get("Title")).sort()).toEqual(["fresh", "seed"]);
    expect((await run(home.dir, ["read", "fresh"])).out).toBe(`${PWNED_PW}\n`);
    for (const text of [r.out, r.err]) {
      expect(hasMarker(text)).toBe(false);
      expect(text.includes(sha1Upper(PWNED_PW)) || text.includes(suffixOf(PWNED_PW).slice(0, 6))).toBe(false);
    }
  });

  it("漏洩なしのときは何も言わない。日本語の文言もある。通信できないときは「スキップしました」で、保存も終了コードも変わらない", async () => {
    reset();
    const { home } = await seeded();
    const clean = await run(home.dir, ["auto", "add", "--title", "c1"], { answers: [CLEAN_PW, CLEAN_PW] });
    expect(clean.code).toBe(0);
    expect(clean.err).toBe("");
    expect(breach.calls).toHaveLength(1);

    reset();
    const ja = await run(home.dir, ["auto", "add", "--title", "c2"], { answers: [PWNED_PW, PWNED_PW], lang: "ja" });
    expect(ja.err).toBe("この値は漏洩済みです(4321 回)。別の値にしてください。\n");

    reset();
    breach.mode = { kind: "throw" };
    const off = await run(home.dir, ["auto", "add", "--title", "c3"], { answers: ["pw-3", "pw-3"] });
    expect(off.code).toBe(0);
    expect(off.err).toBe("Breach check skipped.\n");
    expect((await run(home.dir, ["read", "c3"])).out).toBe("pw-3\n");

    reset();
    breach.mode = { kind: "status", status: 500 };
    const err500 = await run(home.dir, ["auto", "add", "--title", "c4"], { answers: ["pw-4", "pw-4"], lang: "ja" });
    expect(err500.code).toBe(0);
    expect(err500.err).toBe("漏洩チェックをスキップしました。\n");
    reset();
  });

  it("API キーの項目は要求を送らない(add と update --value の両方)。--value なしの update も送らない", async () => {
    reset();
    const { home } = await seeded();
    const add = await run(home.dir, ["auto", "add", "--title", "key1", "--type", "apikey"], { answers: [PWNED_PW, PWNED_PW] });
    expect(add.code).toBe(0);
    expect(add.err).toBe("");
    const upKey = await run(home.dir, ["auto", "update", "--title", "key1", "--value"], { answers: [PWNED_PW, PWNED_PW] });
    expect(upKey.code).toBe(0);
    expect(upKey.err).toBe("");
    const upMeta = await run(home.dir, ["auto", "update", "--title", "seed", "--username", "someone"]);
    expect(upMeta.code).toBe(0);
    expect(upMeta.err).toBe("");
    expect(breach.calls).toHaveLength(0);
  });

  it("auto update --value(パスワード)のあと、その項目だけ要求を1回送る。漏洩済みでも保存は残り、終了コード 0", async () => {
    reset();
    const { vault, home } = await seeded();
    const up = await run(home.dir, ["auto", "update", "--title", "seed", "--value"], { answers: [PWNED_PW, PWNED_PW] });
    expect(up.code).toBe(0);
    expect(up.err).toContain("(4321 times)");
    expect(breach.calls).toHaveLength(1);
    expect((await run(home.dir, ["read", "seed"])).out).toBe(`${PWNED_PW}\n`);
    const server = await openWithKeyFile(mock.vaults.get(vault)!.bytes, home.keyFile);
    expect(liveEntries(server)).toHaveLength(1);
  });

  it("保存に失敗したときはチェックを送らない。PWM_BREACH_URL が誤りでも、保存は残り、終了コード 0", async () => {
    reset();
    const { home } = await seeded();
    mock.down = true;
    const down = await run(home.dir, ["auto", "add", "--title", "d1"], { answers: [PWNED_PW, PWNED_PW] });
    mock.down = false;
    expect(down.code).not.toBe(0);
    expect(breach.calls).toHaveLength(0);

    const bad = await run(home.dir, ["auto", "add", "--title", "d2"], {
      answers: [PWNED_PW, PWNED_PW],
      environ: { ...ENVIRON, PWM_BREACH_URL: "https://example.com" },
    });
    expect(bad.code).toBe(0);
    expect(bad.err).toContain("PWM_BREACH_URL");
    expect(bad.err.includes("example.com")).toBe(false);
    expect(breach.calls).toHaveLength(0);
    expect((await run(home.dir, ["read", "d2"])).out).toBe(`${PWNED_PW}\n`);
  });
});
