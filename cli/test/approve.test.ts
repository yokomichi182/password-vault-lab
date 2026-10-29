import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveEntries, openWithKeyFile, toCredential } from "../src/kdbx.ts";
import { runPwm } from "../src/pwm.ts";
import { parseApproveOutput, type ApproveOutcome } from "../src/approve/protocol.ts";
import { FILES } from "../src/store.ts";
import { BreachTable, FakeBreachFetch } from "./breachFixture.ts";
import { MockSync } from "./mockSync.ts";
import { ScriptedDialog, makeWorld, type ApproveWorld } from "./approveFixture.ts";
import { CANARY_AUTOM, CANARY_MAIN, MASTER, hasMarker, makeCtx, registerHomeScan } from "./helpers.ts";

registerHomeScan();

// 4-1 の 1〜5、10(request_credential の子のプロセス pwm approve-credential)
const PW_MAIN = `${CANARY_MAIN}-main-site-pw`;
const KEY_MAIN = `${CANARY_MAIN}-main-api-key`;
const MAIN_ITEMS = [
  { title: "Main Site", username: "alice-main", password: PW_MAIN, url: "https://main.example.test/", notes: "memo", environment: "prod", expires: new Date(2031, 4, 20, 23, 59, 59) },
  { title: "Main Key", username: "key-id", password: KEY_MAIN, type: "apikey", environment: "live" },
  { title: "Main Note", password: "n", type: "securenote" },
  { title: "Twin", password: "t1" },
  { title: "Twin", password: "t2" },
];

const mock = new MockSync();
beforeAll(async () => void (await mock.start()));
afterAll(() => mock.stop());

const table = new BreachTable();
table.addPwned(PW_MAIN, 777);
const breach = new FakeBreachFetch(table);
/** 漏洩チェックの先は差し替えた fetch。同期先のモックだけ本物の fetch でつなぐ。 */
const routed: typeof fetch = (input, init) => (String(input).includes("/range/") ? breach.fetch(input, init) : fetch(input, init));
const ENVIRON = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PWM_BREACH_URL: "http://127.0.0.1:9" };

async function approve(world: ApproveWorld, dialog: ScriptedDialog, title: string, opts: { fetchImpl?: typeof fetch; client?: string } = {}) {
  const t = makeCtx(world.home.dir, { fetchImpl: opts.fetchImpl ?? routed, environ: ENVIRON, tty: false });
  const argv = ["approve-credential", "--title", title];
  if (opts.client !== undefined) argv.push("--client", opts.client);
  const code = await runPwm(argv, t.ctx, { dialog });
  const line = t.stdout();
  return { code, line, outcome: parseApproveOutput(line) as ApproveOutcome, err: t.stderr() };
}

const putsOf = () => mock.requests.filter((r) => r.method === "PUT").length;

describe("request_credential(子のプロセス)", () => {
  it("今回だけ返す: 項目の値が返り、自動処理用の保管庫のファイルは1バイトも変わらず、同期先に PUT が来ない", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    const before = await readFile(path.join(w.home.dir, FILES.automationKdbx));
    const autoVersion = mock.vaults.get(w.autoVault)!.version;
    const puts = putsOf();
    const d = new ScriptedDialog({ master: MASTER, choice: "once" });
    const r = await approve(w, d, "Main Site", { client: "my-ai" });
    expect(r.code).toBe(0);
    expect(r.outcome).toEqual({
      result: "ok",
      credential: { username: "alice-main", password: PW_MAIN, url: "https://main.example.test/", notes: "memo", type: "password", environment: "prod", expires: "2031-05-20" },
      returnedOnce: true,
      copied: false,
    });
    // ダイアログに見せたもの(項目名・AI の名前・時刻)と、解除後の種類とユーザー名の一部
    expect(d.requests[0]).toMatchObject({ title: "Main Site", client: "my-ai", lang: "en", timeoutSec: 120 });
    expect(d.requests[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(d.unlocked[0]).toEqual({ type: "password", userHint: "al…" });
    // 書かれていない
    expect(Buffer.from(await readFile(path.join(w.home.dir, FILES.automationKdbx))).equals(Buffer.from(before))).toBe(true);
    expect(putsOf()).toBe(puts);
    expect(mock.vaults.get(w.autoVault)!.version).toBe(autoVersion);
    // 標準エラーには何も出さない。標準出力は JSON の1行だけ
    expect(r.err).toBe("");
    expect(r.line.trim().split("\n")).toHaveLength(1);
    // 漏洩チェックは複製のときだけ(今回だけは送らない)
    expect(breach.calls.filter((c) => c.url.includes("/range/"))).toHaveLength(0);
  });

  it("API キーの項目も返す(種類 apikey)。ユーザー名が2文字以下なら … だけ", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    const d = new ScriptedDialog({ master: MASTER, choice: "once" });
    const r = await approve(w, d, "Main Key");
    expect(r.outcome).toMatchObject({ result: "ok", returnedOnce: true, copied: false, credential: { password: KEY_MAIN, type: "apikey", environment: "live" } });
    expect(d.unlocked[0]).toEqual({ type: "apikey", userHint: "ke…" });
  });

  it("複製してから返す: 自動処理用の保管庫に項目が1つ増え、read で読める。UUID は新しく、漏洩チェックの結果が breach に入る", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    breach.calls = [];
    const d = new ScriptedDialog({ master: MASTER, choice: "copy" });
    const r = await approve(w, d, "Main Site");
    expect(r.outcome).toMatchObject({ result: "ok", returnedOnce: false, copied: true, breach: { status: "pwned", count: 777 } });
    // 同期先とローカルの自動処理用の保管庫に増えている(If-Match 付きの PUT が1回)
    const put = mock.requests.filter((q) => q.method === "PUT" && q.path === `/vaults/${w.autoVault}`);
    expect(put).toHaveLength(1);
    expect(put[0]!.ifMatch).toBe("1");
    const db = await openWithKeyFile(mock.vaults.get(w.autoVault)!.bytes, w.home.keyFile);
    const titles = liveEntries(db).map((e) => toCredential(e).title).sort();
    expect(titles).toEqual(["Main Site", "seed"]);
    const copied = liveEntries(db).find((e) => toCredential(e).title === "Main Site")!;
    expect(toCredential(copied)).toMatchObject({ username: "alice-main", password: PW_MAIN, url: "https://main.example.test/", notes: "memo", type: "password", environment: "prod", expires: "2031-05-20" });
    const mainDb = await (await import("../src/kdbx.ts")).openWithPassword(mock.vaults.get(w.mainVault)!.bytes, MASTER);
    const original = liveEntries(mainDb).find((e) => toCredential(e).title === "Main Site")!;
    expect(copied.uuid.id).not.toBe(original.uuid.id);
    // 以後は pwm read(承認なし、通信なし)で読める
    const t = makeCtx(w.home.dir, { tty: false });
    expect(await runPwm(["read", "Main Site"], t.ctx)).toBe(0);
    expect(t.stdout()).toBe(PW_MAIN + "\n");
    // 漏洩チェックは複製したあとの1回だけ
    expect(breach.calls.filter((c) => c.url.includes("/range/"))).toHaveLength(1);
    expect(r.err).toBe("");
  });

  it("API キーを複製すると、種類と環境が写り、漏洩チェックは対象外(ハッシュを送らない)", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    breach.calls = [];
    const r = await approve(w, new ScriptedDialog({ master: MASTER, choice: "copy" }), "Main Key");
    expect(r.outcome).toMatchObject({ result: "ok", copied: true, breach: { status: "notApplicable" } });
    expect(breach.calls).toHaveLength(0);
    const db = await openWithKeyFile(mock.vaults.get(w.autoVault)!.bytes, w.home.keyFile);
    const c = toCredential(liveEntries(db).find((e) => toCredential(e).title === "Main Key")!);
    expect(c).toMatchObject({ type: "apikey", environment: "live", password: KEY_MAIN });
  });

  it("複製に失敗したとき(オフライン・同期先の拒否)は、値を今回だけ返し、copied: false と理由の種類を返す。理由に値が入らない", async () => {
    for (const [kind, put] of [
      ["offline", (): Response => { throw new Error("down"); }],
      ["rejected", (): Response => new Response("{}", { status: 413 })],
    ] as const) {
      const w = await makeWorld(mock, MAIN_ITEMS);
      const wrapped: typeof fetch = (input, init) => (init?.method === "PUT" ? Promise.resolve(put()) : routed(input, init));
      const r = await approve(w, new ScriptedDialog({ master: MASTER, choice: "copy" }), "Main Site", { fetchImpl: wrapped });
      expect(r.outcome, kind).toMatchObject({ result: "ok", returnedOnce: true, copied: false, copyFailure: kind, credential: { password: PW_MAIN } });
      expect((r.outcome as { breach?: unknown }).breach).toBeUndefined();
      expect(r.line.replace(PW_MAIN, "").includes(CANARY_MAIN)).toBe(false); // 値は credential の password にしか出ない
      expect(mock.vaults.get(w.autoVault)!.version).toBe(1);
    }
  });

  it("拒否、1段目で拒否、閉じた(拒否と同じ)、マスターパスワードの誤り: どれも値を返さず denied だけ。誤りであることを伝えない", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    const puts = putsOf();
    const scripts = [
      { master: MASTER, choice: "deny" as const }, // 2段目で拒否
      {}, // 1段目で拒否・閉じた・時間切れ(ダイアログは deny を返す)
      { master: "wrong-master-password", choice: "once" as const }, // 誤り
    ];
    const lines: string[] = [];
    for (const s of scripts) {
      const r = await approve(w, new ScriptedDialog(s), "Main Site");
      expect(r.outcome).toEqual({ result: "denied" });
      expect(hasMarker(r.line)).toBe(false);
      lines.push(r.line);
    }
    expect(new Set(lines).size).toBe(1); // 区別できない
    expect(putsOf()).toBe(puts);
  });

  it("本体に項目が無い、知らない種類、同じ項目名が2件: not_found", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    for (const title of ["Nope", "Main Note", "Twin"]) {
      const d = new ScriptedDialog({ master: MASTER, choice: "once" });
      const r = await approve(w, d, title);
      expect(r.outcome, title).toEqual({ result: "not_found" });
      expect(d.unlocked[0]).toBeNull();
    }
  });

  it("同期先とつながらない、本体の設定が無い: unavailable。設定が無いときはダイアログを出さない", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    mock.down = true;
    try {
      const r = await approve(w, new ScriptedDialog({ master: MASTER, choice: "once" }), "Main Site");
      expect(r.outcome).toEqual({ result: "unavailable" });
    } finally {
      mock.down = false;
    }
    const none = await makeWorld(mock, MAIN_ITEMS, undefined, { withMain: false });
    const d = new ScriptedDialog({ master: MASTER, choice: "once" });
    const r2 = await approve(none, d, "Main Site");
    expect(r2.outcome).toEqual({ result: "unavailable" });
    expect(d.calls).toBe(0);
  });

  it("ダイアログを出せないとき(例外)は unavailable", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    const t = makeCtx(w.home.dir, { fetchImpl: routed, environ: ENVIRON, tty: false });
    const boom = { ask: () => Promise.reject(new Error("no ps")) };
    expect(await runPwm(["approve-credential", "--title", "Main Site"], t.ctx, { dialog: boom })).toBe(0);
    expect(parseApproveOutput(t.stdout())).toEqual({ result: "unavailable" });
  });

  it("同時に1つまで: 新しい錠があれば busy でダイアログを出さない。古い錠(落ちたプロセスの残り)は外して進む。終わったら錠が残らない", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    const lock = path.join(w.home.dir, "approve.lock");
    await writeFile(lock, "");
    const d = new ScriptedDialog({ master: MASTER, choice: "once" });
    const busy = await approve(w, d, "Main Site");
    expect(busy.outcome).toEqual({ result: "busy" });
    expect(d.calls).toBe(0);
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old);
    const ok = await approve(w, d, "Main Site");
    expect(ok.outcome.result).toBe("ok");
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("引数: タイトルが空・知らない引数はエラーで、ダイアログを出さない。AI の名前の制御文字は空白に、64文字で切る", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    const d = new ScriptedDialog({ master: MASTER, choice: "once" });
    for (const argv of [["approve-credential"], ["approve-credential", "--title", ""], ["approve-credential", "--title", "x", "--password", "y"]]) {
      const t = makeCtx(w.home.dir, { tty: false });
      expect(await runPwm(argv, t.ctx, { dialog: d })).not.toBe(0);
      expect(t.stdout()).toBe("");
    }
    expect(d.calls).toBe(0);
    await approve(w, d, "Main Site", { client: "evil\u0007\nname " + "x".repeat(100) });
    const shown = d.requests[0]!.client;
    expect(shown).not.toMatch(/[\u0000-\u001f]/);
    expect(Array.from(shown).length).toBeLessThanOrEqual(64);
    expect(shown.startsWith("evil  name")).toBe(true);
  });

  it("目印: 標準エラーに何も出ない。標準出力に出るのは返す JSON だけで、本体の保管庫以外の値は混ざらない", async () => {
    const w = await makeWorld(mock, MAIN_ITEMS);
    const r = await approve(w, new ScriptedDialog({ master: MASTER, choice: "once" }), "Main Site");
    expect(r.err).toBe("");
    expect(r.line.includes(CANARY_AUTOM)).toBe(false);
    expect(r.line.includes(MASTER)).toBe(false);
  });
});
