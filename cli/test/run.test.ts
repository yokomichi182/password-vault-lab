import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenVault } from "../../extension/src/shared/vault.ts";
import { runPwm } from "../src/pwm.ts";
import { CONCEALED, Concealer } from "../src/run.ts";
import { FILES } from "../src/store.ts";
import { MockSync } from "./mockSync.ts";
import { CANARY_AUTOM, CANARY_MAIN, MASTER, hasMarker, makeCtx, makeHome, makeKdbx, registerHomeScan, tmpHome } from "./helpers.ts";
import { writeFile } from "node:fs/promises";

registerHomeScan();

const CHILD = path.join(import.meta.dirname, "child.cjs");
const NODE = process.execPath;
const SECRET = `${CANARY_AUTOM}-run-secret`;
const ITEMS = [
  { title: "svc", password: SECRET, type: "apikey", environment: "prod" },
  { title: "other", username: "someone", password: `${CANARY_AUTOM}-other` },
];

async function pwmRun(home: string, args: string[], opts: Parameters<typeof makeCtx>[1] = {}) {
  const t = makeCtx(home, opts);
  const code = await runPwm(["run", ...args], t.ctx);
  return { code, out: t.stdout(), err: t.stderr(), asked: t.asked };
}

describe("3. pwm run が子に変数を渡す", () => {
  it("子は値を出さずに、期待どおりかだけを出す。子の終了コードがそのまま返る", async () => {
    const h = await makeHome(ITEMS);
    const ok = await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--env", "MY_USER=other/username", "--", NODE, CHILD, "check", "MY_KEY", SECRET]);
    expect(ok).toMatchObject({ code: 0, out: "match" });
    expect((await pwmRun(h.dir, ["--env", "MY_USER=other/username", "--", NODE, CHILD, "check", "MY_USER", "someone"])).out).toBe("match");
    expect((await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--", NODE, CHILD, "check", "MY_KEY", "wrong"])).out).toBe("mismatch");
    for (const code of [0, 3, 42]) {
      expect((await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--", NODE, CHILD, "exit", String(code)])).code).toBe(code);
    }
  });

  it("シェルを通さない(コマンドの文字列は展開されず、起動できないときは失敗)", async () => {
    const h = await makeHome(ITEMS);
    const r = await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--", "no-such-program-for-pwm-test"]);
    expect(r.code).not.toBe(0);
    expect(hasMarker(r.err + r.out)).toBe(false);
    // 引数の `&` や `;` はそのまま子に渡る(シェルが解釈しない)
    const echoLen = await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--", NODE, CHILD, "len", "MY_KEY&echo"]);
    expect(echoLen).toMatchObject({ code: 0, out: "0" });
  });

  it("環境は今の環境に指定した変数を足したもの", async () => {
    const h = await makeHome(ITEMS);
    const r = await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--", NODE, CHILD, "len", "KEEP_ME"], {
      environ: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, KEEP_ME: "12345" },
    });
    expect(r.out).toBe("5");
  });
});

describe("4. pwm run の伏せ字", () => {
  it("子が値を標準出力と標準エラーに出しても、pwm の出力には <concealed by pwm> だけが出る", async () => {
    const h = await makeHome(ITEMS);
    const r = await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--", NODE, CHILD, "echo", "MY_KEY"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`out:${CONCEALED}:end\n`);
    expect(r.err).toBe(`err:${CONCEALED}:end\n`);
    expect(hasMarker(r.out + r.err)).toBe(false);
  });

  it("値がチャンクの切れ目にまたがる場合も置き換わる", async () => {
    const h = await makeHome(ITEMS);
    const r = await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--", NODE, CHILD, "split", "MY_KEY"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`head:${CONCEALED}:tail\n`);
    expect(hasMarker(r.out + r.err)).toBe(false);
  });

  it("Concealer: どんな位置で分けても同じ結果になる。複数の値、前後に別の文字がある場合", () => {
    const secret = `${CANARY_AUTOM}-boundary`;
    const other = "second-value";
    const text = Buffer.from(`aa${secret}bb${other}cc${secret}${secret}dd`);
    const expected = `aa${CONCEALED}bb${CONCEALED}cc${CONCEALED}${CONCEALED}dd`;
    for (let i = 0; i <= text.length; i++) {
      for (const j of [i, Math.min(text.length, i + 7), Math.min(text.length, i + 19)]) {
        const c = new Concealer([secret, other]);
        const out = Buffer.concat([c.push(text.subarray(0, i)), c.push(text.subarray(i, j)), c.push(text.subarray(j)), c.flush()]);
        expect(out.toString()).toBe(expected);
      }
    }
    // 値を変形した出力(逆順など)は置き換えられない。既知の限界
    const c = new Concealer([secret]);
    const reversed = [...secret].reverse().join("");
    expect(Buffer.concat([c.push(Buffer.from(reversed)), c.flush()]).toString()).toBe(reversed);
  });
});

describe("17. pwm run の NAME の検査と --timeout", () => {
  it("不正な名前、PATH など既存の変数の上書きはエラー。ボールト(値)を開く前に断る", async () => {
    const h = await makeHome(ITEMS);
    for (const spec of ["1BAD=svc", "BAD-NAME=svc", "=svc", "A B=svc", `${"X".repeat(65)}=svc`, "NOEQUALS", "PATH=svc", "path=svc", "SystemRoot=svc"]) {
      const r = await pwmRun(h.dir, ["--env", spec, "--", NODE, CHILD, "exit", "0"]);
      expect(r.code, spec).not.toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toContain("pwm:");
    }
    // 同じ名前の指定が2つ
    expect((await pwmRun(h.dir, ["--env", "DUP=svc", "--env", "dup=other", "--", NODE, CHILD, "exit", "0"])).code).not.toBe(0);
    // --env なし、コマンドなし、--timeout が不正
    expect((await pwmRun(h.dir, ["--", NODE, CHILD, "exit", "0"])).code).not.toBe(0);
    expect((await pwmRun(h.dir, ["--env", "MY_KEY=svc"])).code).not.toBe(0);
    expect((await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--timeout", "0", "--", NODE, CHILD, "exit", "0"])).code).not.toBe(0);
    expect((await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--timeout", "abc", "--", NODE, CHILD, "exit", "0"])).code).not.toBe(0);
  });

  it("--timeout を過ぎた子が止まり、終了コード 124", async () => {
    const h = await makeHome(ITEMS);
    const started = Date.now();
    const r = await pwmRun(h.dir, ["--env", "MY_KEY=svc", "--timeout", "1", "--", NODE, CHILD, "sleep"]);
    expect(r.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe("pwm run --main(対話用の本体の保管庫)", () => {
  const mock = new MockSync();
  beforeAll(async () => void (await mock.start()));
  afterAll(() => mock.stop());

  it("端末のときだけ使え、本体の保管庫の値を子に渡す。伏せ字になる", async () => {
    const dir = await tmpHome();
    const tokenMain = `${CANARY_MAIN}-run-main-token`;
    mock.tokens.set(tokenMain, "main");
    mock.setVault("main", await makeKdbx({ master: MASTER }, [{ title: "site", password: `${CANARY_MAIN}-site-pw` }]));
    await writeFile(path.join(dir, "main.token.kdbx"), await createTokenVault(MASTER, tokenMain));
    await writeFile(path.join(dir, FILES.config), JSON.stringify({ syncUrl: mock.url, mainVault: "main" }));

    // 端末でない: マスターパスワードを聞かず、通信もしない
    const notTty = await pwmRun(dir, ["--main", "--env", "K=site", "--", NODE, CHILD, "echo", "K"], { tty: false, answers: [MASTER], fetchImpl: fetch });
    expect(notTty.code).not.toBe(0);
    expect(notTty.asked).toEqual([]);
    expect(mock.requests).toHaveLength(0);

    const r = await pwmRun(dir, ["--main", "--env", "K=site", "--", NODE, CHILD, "echo", "K"], { answers: [MASTER], fetchImpl: fetch });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`out:${CONCEALED}:end\n`);
    expect(hasMarker(r.out + r.err)).toBe(false);
    expect((await readFile(path.join(dir, "main.kdbx"))).length).toBeGreaterThan(0);
  });
});
