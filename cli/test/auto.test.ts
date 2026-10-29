import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENTROPY_AUTOMATION_KEY } from "../src/ctx.ts";
import { fetchVault } from "../../extension/src/shared/sync.ts";
import { createKeyFile, kdbxweb, liveEntries, openWithKeyFile, openWithPassword } from "../src/kdbx.ts";
import { runPwm } from "../src/pwm.ts";
import { FILES } from "../src/store.ts";
import { MockSync } from "./mockSync.ts";
import {
  CANARY_AUTOM,
  CANARY_MAIN,
  FakeProtector,
  MASTER,
  hasMarker,
  makeCtx,
  makeHome,
  makeKdbx,
  registerHomeScan,
  tmpHome,
  type Home,
} from "./helpers.ts";

registerHomeScan();

const TOKEN = `${CANARY_AUTOM}-tok-auto`;
const TOKEN_MAIN = `${CANARY_MAIN}-tok-main`;

const mock = new MockSync();
beforeAll(async () => {
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
});

let vaultSeq = 0;
function freshVault(): string {
  vaultSeq += 1;
  const name = `v${vaultSeq}`;
  mock.tokens.set(TOKEN, name); // 1つのトークンは1つの保管庫だけ(各テストで付け替える)
  return name;
}

const run = (home: string, argv: string[], opts: Parameters<typeof makeCtx>[1] = {}) => {
  const t = makeCtx(home, { fetchImpl: fetch, ...opts });
  return runPwm(argv, t.ctx).then((code) => ({ code, out: t.stdout(), err: t.stderr(), asked: t.asked, ctx: t.ctx }));
};

async function serverDb(vault: string, home: Home) {
  return openWithKeyFile(mock.vaults.get(vault)!.bytes, home.keyFile);
}

/** 自動処理用の保管庫が同期先とローカルの両方にある状態を作る。 */
async function seeded(items: Parameters<typeof makeHome>[0] = [{ title: "seed", password: `${CANARY_AUTOM}-seed` }]) {
  const vault = freshVault();
  const home = await makeHome(items, { token: TOKEN, syncUrl: mock.url, vault });
  mock.setVault(vault, new Uint8Array(await readFile(path.join(home.dir, FILES.automationKdbx))));
  return { vault, home };
}

describe("5. pwm auto init・add・update・remove", () => {
  it("init は If-Match: 0 で PUT し、成功したときだけファイルを置く。add・update・remove は If-Match 付きで PUT し、ローカルも新しい版になる", async () => {
    const vault = freshVault();
    const dir = await tmpHome();
    const before = mock.requests.length;
    const init = await run(dir, ["auto", "init", "--sync-url", mock.url, "--vault", vault], { answers: [TOKEN] });
    expect(init.code).toBe(0);
    const initReqs = mock.requests.slice(before);
    const put0 = initReqs.find((r) => r.method === "PUT");
    expect(put0?.ifMatch).toBe("0");
    expect((await readdir(dir)).sort()).toEqual(
      [FILES.automationKdbx, FILES.automationKey, FILES.automationToken, FILES.config].sort(),
    );
    expect(Buffer.from(await readFile(path.join(dir, FILES.automationKdbx))).equals(Buffer.from(mock.vaults.get(vault)!.bytes))).toBe(true);
    // キーファイルは DPAPI の包みの中にだけある(平文のキーファイルをディスクに書かない)
    const keyFile = await new FakeProtector().unprotect(await readFile(path.join(dir, FILES.automationKey)), ENTROPY_AUTOMATION_KEY);
    expect(Buffer.from(await readFile(path.join(dir, FILES.automationKey))).includes(Buffer.from(keyFile))).toBe(false);

    const mark = mock.requests.length;
    const add = await run(dir, ["auto", "add", "--title", "svc", "--username", "u1", "--url", "https://svc.example.test", "--type", "apikey", "--env", "prod", "--expires", "2031-01-31", "--notes"], {
      answers: [`${CANARY_AUTOM}-v1`, `${CANARY_AUTOM}-v1`, `${CANARY_AUTOM}-note`],
    });
    expect(add.code).toBe(0);
    const put1 = mock.requests.slice(mark).find((r) => r.method === "PUT");
    expect(put1?.ifMatch).toBe("1");
    expect(mock.vaults.get(vault)!.version).toBe(2);
    expect(Buffer.from(await readFile(path.join(dir, FILES.automationKdbx))).equals(Buffer.from(mock.vaults.get(vault)!.bytes))).toBe(true);

    let db = await openWithKeyFile(mock.vaults.get(vault)!.bytes, keyFile);
    const e = liveEntries(db)[0]!;
    expect(e.fields.get("ItemType")).toBe("apikey");
    expect(e.fields.get("Environment")).toBe("prod");
    expect(e.times.expires).toBe(true);

    expect((await run(dir, ["read", "svc/password"])).out).toBe(`${CANARY_AUTOM}-v1\n`);
    expect((await run(dir, ["read", "svc/notes"])).out).toBe(`${CANARY_AUTOM}-note\n`);
    expect((await run(dir, ["read", "svc/expires"])).out).toBe("2031-01-31\n");

    // password の種類は属性を書かない
    expect((await run(dir, ["auto", "add", "--title", "plain"], { answers: ["pw-a", "pw-a"] })).code).toBe(0);
    db = await openWithKeyFile(mock.vaults.get(vault)!.bytes, keyFile);
    expect(liveEntries(db).find((x) => x.fields.get("Title") === "plain")!.fields.has("ItemType")).toBe(false);

    // update: 値を変え、期限を消す
    const up = await run(dir, ["auto", "update", "--title", "svc", "--username", "u2", "--expires", "", "--value"], {
      answers: [`${CANARY_AUTOM}-v2`, `${CANARY_AUTOM}-v2`],
    });
    expect(up.code).toBe(0);
    expect((await run(dir, ["read", "svc/password"])).out).toBe(`${CANARY_AUTOM}-v2\n`);
    expect((await run(dir, ["read", "svc/username"])).out).toBe("u2\n");
    expect((await run(dir, ["read", "svc/expires"])).out).toBe("\n");
    expect((await run(dir, ["read", "svc/type"])).out).toBe("apikey\n");

    // list は値を出さない
    const list = await run(dir, ["auto", "list"]);
    expect(list.out).toContain("svc\tapikey\tprod");
    expect(list.out).toContain("plain\tpassword\t");
    expect(hasMarker(list.out + list.err)).toBe(false);

    // remove: 確認(y)のあとで消し、DeletedObjects に入る(ごみ箱には入れない)
    const target = liveEntries(await openWithKeyFile(mock.vaults.get(vault)!.bytes, keyFile)).find((x) => x.fields.get("Title") === "svc")!;
    const targetId = target.uuid.id;
    const rm = await run(dir, ["auto", "remove", "--title", "svc"], { answers: ["y"] });
    expect(rm.code).toBe(0);
    db = await openWithKeyFile(mock.vaults.get(vault)!.bytes, keyFile);
    expect(liveEntries(db).some((x) => x.fields.get("Title") === "svc")).toBe(false);
    expect(db.deletedObjects.some((d) => d.uuid?.id === targetId)).toBe(true);
    expect([...db.getDefaultGroup().allEntries()].some((x) => x.uuid.id === targetId)).toBe(false); // ごみ箱の中にも残らない
    expect((await run(dir, ["read", "svc/password"])).code).not.toBe(0);
  });

  it("remove は y 以外の答えでは消さない。同じタイトルの add、中止(Ctrl+C)、2回の入力の不一致は何も書かない", async () => {
    const { vault, home } = await seeded();
    const v0 = mock.vaults.get(vault)!.version;
    expect((await run(home.dir, ["auto", "remove", "--title", "seed"], { answers: ["n"] })).code).not.toBe(0);
    expect((await run(home.dir, ["auto", "add", "--title", "seed"], { answers: ["a", "a"] })).code).not.toBe(0);
    expect((await run(home.dir, ["auto", "add", "--title", "new1"], { answers: ["a", "b"] })).code).not.toBe(0);
    expect((await run(home.dir, ["auto", "add", "--title", "new2"], { answers: [null] })).code).not.toBe(0);
    expect(mock.vaults.get(vault)!.version).toBe(v0);
  });

  it("init: サーバーにすでに版があるときは作らない。ファイルを置かない", async () => {
    const vault = freshVault();
    mock.setVault(vault, new Uint8Array(await makeKdbx({ keyFile: await createKeyFile() }, [])));
    const dir = await tmpHome();
    const r = await run(dir, ["auto", "init", "--sync-url", mock.url, "--vault", vault], { answers: [TOKEN] });
    expect(r.code).not.toBe(0);
    expect(await readdir(dir)).toEqual([]);
    expect(mock.vaults.get(vault)!.version).toBe(1);
  });

  it("init: トークンが違う(401)・通信できないときも、ファイルを置かない", async () => {
    const vault = freshVault();
    const dir = await tmpHome();
    const r = await run(dir, ["auto", "init", "--sync-url", mock.url, "--vault", vault], { answers: ["wrong-token"] });
    expect(r.code).not.toBe(0);
    mock.down = true;
    const r2 = await run(dir, ["auto", "init", "--sync-url", mock.url, "--vault", vault], { answers: [TOKEN] });
    mock.down = false;
    expect(r2.code).not.toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("空のトークンを送らない(フェーズ3.5の PC での確認から)", () => {
  it("auto init と main setup は、空のトークン(と空のマスターパスワード)で「入力が空です」と止まり、fetch を呼ばず、ファイルを置かない", async () => {
    const dir = await tmpHome();
    let calls = 0;
    const spy: typeof fetch = () => {
      calls += 1;
      return Promise.reject(new Error("must not be called"));
    };
    const cases: { argv: string[]; answers: string[] }[] = [
      { argv: ["auto", "init", "--sync-url", mock.url], answers: [""] },
      { argv: ["main", "setup", "--sync-url", mock.url], answers: [""] },
      { argv: ["main", "setup", "--sync-url", mock.url], answers: [TOKEN_MAIN, ""] },
    ];
    for (const c of cases) {
      const t = makeCtx(dir, { fetchImpl: spy, answers: c.answers });
      expect(await runPwm(c.argv, t.ctx), c.argv.join(" ")).toBe(1);
      expect(t.stderr()).toContain("The input is empty");
      expect(t.stdout()).toBe("");
    }
    expect(calls).toBe(0);
    expect(await readdir(dir)).toEqual([]);
    // 日本語
    const ja = makeCtx(dir, { fetchImpl: spy, answers: [""], lang: "ja" });
    expect(await runPwm(["auto", "init", "--sync-url", mock.url], ja.ctx)).toBe(1);
    expect(ja.stderr()).toContain("入力が空です");
    expect(calls).toBe(0);
  });
});

describe("6. 書き込みの 409", () => {
  it("別の書き込みで版が進んでいても、変更を新しい版に当て直して通り、もう一方の変更も消えない", async () => {
    const { vault, home } = await seeded();
    const other = await openWithKeyFile(mock.vaults.get(vault)!.bytes, home.keyFile);
    const e = other.createEntry(other.getDefaultGroup());
    e.fields.set("Title", "other");
    e.fields.set("Password", kdbxweb.ProtectedValue.fromString("other-pw"));
    const otherBytes = new Uint8Array(await other.save());
    let hookCalls = 0;
    mock.beforePut = (name) => {
      hookCalls += 1;
      if (hookCalls === 1) mock.setVault(name, otherBytes);
    };
    const mark = mock.requests.length;
    const r = await run(home.dir, ["auto", "add", "--title", "mine"], { answers: [`${CANARY_AUTOM}-m`, `${CANARY_AUTOM}-m`] });
    mock.beforePut = undefined;
    expect(r.code).toBe(0);
    const puts = mock.requests.slice(mark).filter((q) => q.method === "PUT");
    expect(puts.map((q) => q.ifMatch)).toEqual(["1", "2"]); // 1回目は 409、取り直して2回目で通る
    const titles = liveEntries(await serverDb(vault, home)).map((x) => x.fields.get("Title"));
    expect(titles.sort()).toEqual(["mine", "other", "seed"]);
    expect(Buffer.from(await readFile(path.join(home.dir, FILES.automationKdbx))).equals(Buffer.from(mock.vaults.get(vault)!.bytes))).toBe(true);
  });

  it("3回続けて 409 ならやめ、ローカルのファイルが変わらない", async () => {
    const { vault, home } = await seeded();
    const localBefore = await readFile(path.join(home.dir, FILES.automationKdbx));
    mock.beforePut = (name) => {
      const cur = mock.vaults.get(name)!;
      mock.setVault(name, cur.bytes); // 版だけ進める
    };
    const mark = mock.requests.length;
    const r = await run(home.dir, ["auto", "add", "--title", "mine"], { answers: ["a", "a"] });
    mock.beforePut = undefined;
    expect(r.code).not.toBe(0);
    expect(mock.requests.slice(mark).filter((q) => q.method === "PUT")).toHaveLength(3);
    expect((await readFile(path.join(home.dir, FILES.automationKdbx))).equals(localBefore)).toBe(true);
    expect(liveEntries(await serverDb(vault, home)).map((x) => x.fields.get("Title"))).toEqual(["seed"]);
    expect(r.err).toContain("Nothing was changed");
  });
});

describe("7. pwm sync", () => {
  it("開ける版で置き換わり、前の版が .bak に残る", async () => {
    const { vault, home } = await seeded();
    const localBefore = await readFile(path.join(home.dir, FILES.automationKdbx));
    const newer = await makeKdbx({ keyFile: home.keyFile }, [
      { title: "seed", password: `${CANARY_AUTOM}-seed` },
      { title: "added-elsewhere", password: `${CANARY_AUTOM}-else` },
    ]);
    mock.setVault(vault, newer);
    const r = await run(home.dir, ["sync"]);
    expect(r.code).toBe(0);
    expect(Buffer.from(await readFile(path.join(home.dir, FILES.automationKdbx))).equals(Buffer.from(newer))).toBe(true);
    expect((await readFile(path.join(home.dir, FILES.automationBak))).equals(localBefore)).toBe(true);
    expect((await run(home.dir, ["read", "added-elsewhere"])).out).toBe(`${CANARY_AUTOM}-else\n`);
    expect(hasMarker(r.out + r.err)).toBe(false);
  });

  it("キーファイルで開けない版では置き換わらない", async () => {
    const { vault, home } = await seeded();
    const localBefore = await readFile(path.join(home.dir, FILES.automationKdbx));
    mock.setVault(vault, await makeKdbx({ keyFile: await createKeyFile() }, [{ title: "stranger", password: "x" }]));
    const r = await run(home.dir, ["sync"]);
    expect(r.code).not.toBe(0);
    expect((await readFile(path.join(home.dir, FILES.automationKdbx))).equals(localBefore)).toBe(true);
    await expect(readFile(path.join(home.dir, FILES.automationBak))).rejects.toThrow();
  });

  it("通信できないとき・401・403 のときは置き換わらず、終了コードが 0 以外", async () => {
    const { vault, home } = await seeded();
    const localBefore = await readFile(path.join(home.dir, FILES.automationKdbx));
    mock.setVault(vault, await makeKdbx({ keyFile: home.keyFile }, [{ title: "newer", password: "x" }]));
    mock.down = true;
    const down = await run(home.dir, ["sync"]);
    mock.down = false;
    expect(down.code).not.toBe(0);
    expect(down.err).toContain("Skipped");
    // 401: 同期先が知らないトークン
    mock.tokens.delete(TOKEN);
    const unauthorized = await run(home.dir, ["sync"]);
    // 403: トークンはあるが、別の保管庫のもの
    mock.tokens.set(TOKEN, "some-other-vault");
    const forbidden = await run(home.dir, ["sync"]);
    mock.tokens.set(TOKEN, vault);
    expect(unauthorized.code).not.toBe(0);
    expect(forbidden.code).not.toBe(0);
    expect((await readFile(path.join(home.dir, FILES.automationKdbx))).equals(localBefore)).toBe(true);
    for (const r of [down, unauthorized, forbidden]) expect(hasMarker(r.out + r.err)).toBe(false);
  });
});

describe("本体の保管庫(対話用): pwm main setup と pwm read --main", () => {
  const MAIN_ITEMS = [{ title: "main-site", username: "me", password: `${CANARY_MAIN}-main-pw` }];

  async function mainFiles(dir: string): Promise<string[]> {
    return (await readdir(dir)).filter((f) => f.startsWith("main")).sort();
  }

  it("setup は開けたときだけ置く。read --main は取得して読み、通信できないときは前回の暗号文で読む。開けない版では上書きしない", async () => {
    const vault = "main-" + (++vaultSeq);
    mock.tokens.set(TOKEN_MAIN, vault);
    mock.setVault(vault, await makeKdbx({ master: MASTER }, MAIN_ITEMS));
    const dir = await tmpHome();

    // マスターパスワードが違うとき: 何も置かない
    const bad = await run(dir, ["main", "setup", "--sync-url", mock.url, "--vault", vault], { answers: [TOKEN_MAIN, "wrong-master"] });
    expect(bad.code).not.toBe(0);
    expect(await mainFiles(dir)).toEqual([]);

    const ok = await run(dir, ["main", "setup", "--sync-url", mock.url, "--vault", vault], { answers: [TOKEN_MAIN, MASTER] });
    expect(ok.code).toBe(0);
    expect(await mainFiles(dir)).toEqual(["main.kdbx", "main.token.kdbx"]);
    expect(hasMarker(ok.out + ok.err)).toBe(false);

    // トークン入れはマスターパスワードで開く(拡張と同じ作り)。マスターパスワードなしでは取り出せない
    const tokenBytes = new Uint8Array(await readFile(path.join(dir, "main.token.kdbx")));
    await expect(openWithPassword(tokenBytes, "wrong")).rejects.toThrow();
    expect(Buffer.from(tokenBytes).includes(Buffer.from(TOKEN_MAIN))).toBe(false);

    const mark = mock.requests.length;
    const read = await run(dir, ["read", "--main", "main-site/password"], { answers: [MASTER] });
    expect(read.code).toBe(0);
    expect(mock.requests.slice(mark).map((q) => q.method)).toEqual(["GET"]); // 読み取りだけ。PUT は作らない
    expect(read.out).toBe(`${CANARY_MAIN}-main-pw\n`);
    expect(read.asked).toHaveLength(1);


    // 通信できないとき: main.kdbx で開き、前回の同期の日時を標準エラーに出す
    mock.down = true;
    const offline = await run(dir, ["read", "--main", "main-site/username"], { answers: [MASTER] });
    mock.down = false;
    expect(offline.out).toBe("me\n");
    expect(offline.err).toContain("last sync");

    // サーバーの版が開けないとき: main.kdbx を上書きしない
    const cached = await readFile(path.join(dir, "main.kdbx"));
    mock.setVault(vault, await makeKdbx({ master: "another-master" }, MAIN_ITEMS));
    const stranger = await run(dir, ["read", "--main", "main-site/password"], { answers: [MASTER] });
    expect(stranger.code).not.toBe(0);
    expect(stranger.out).toBe("");
    expect((await readFile(path.join(dir, "main.kdbx"))).equals(cached)).toBe(true);
    expect(hasMarker(stranger.err)).toBe(false);

    // マスターパスワードが違うとき
    const wrong = await run(dir, ["read", "--main", "main-site/password"], { answers: ["wrong"] });
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toBe("");
  });

  it("自動処理用のトークンで main を GET すると 403、本体のトークンで自動処理用を GET すると 403(モック)", async () => {
    const a = freshVault();
    mock.tokens.set(TOKEN_MAIN, "main-x");
    expect((await fetchVault(mock.url, "main-x", TOKEN)).kind).toBe("auth");
    expect((await fetchVault(mock.url, a, TOKEN_MAIN)).kind).toBe("auth");
  });
});
