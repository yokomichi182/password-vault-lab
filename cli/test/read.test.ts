import { describe, expect, it } from "vitest";
import { parseRef } from "../src/kdbx.ts";
import { runPwm } from "../src/pwm.ts";
import { CANARY_AUTOM, CANARY_MAIN, hasMarker, makeCtx, makeHome, registerHomeScan } from "./helpers.ts";

registerHomeScan();

const EXPIRES = new Date(2031, 4, 20, 23, 59, 59); // 2031-05-20(今の PC のタイムゾーン)

const ITEMS = [
  { title: "plain", username: "alice", password: `${CANARY_AUTOM}-plain`, url: "https://plain.example.test/", notes: "note text" },
  { title: "svc/prod", username: "bob", password: `${CANARY_AUTOM}-slash` },
  { title: "ApiKey", password: `${CANARY_AUTOM}-apikey`, type: "apikey", environment: "production", expires: EXPIRES },
  { title: "explicit", password: `${CANARY_AUTOM}-explicit`, type: "password" },
];

describe("1. 参照の解釈", () => {
  it("最後の / で分ける。/ を含むタイトルも扱える", () => {
    expect(parseRef("plain/password")).toEqual({ title: "plain", field: "password" });
    expect(parseRef("svc/prod/password")).toEqual({ title: "svc/prod", field: "password" });
    expect(parseRef("a/b/c/username")).toEqual({ title: "a/b/c", field: "username" });
  });
  it("欄の名前は大文字と小文字を区別しない", () => {
    expect(parseRef("t/USERNAME").field).toBe("username");
    expect(parseRef("t/Environment").field).toBe("environment");
  });
  it("欄の省略は password", () => {
    expect(parseRef("plain")).toEqual({ title: "plain", field: "password" });
  });
  it("知らない欄・空のタイトル・空の欄はエラー", () => {
    expect(() => parseRef("t/nope")).toThrow();
    expect(() => parseRef("/password")).toThrow();
    expect(() => parseRef("t/")).toThrow();
    expect(() => parseRef("")).toThrow();
  });
});

async function read(home: string, ref: string, extra: string[] = [], lang: "en" | "ja" = "en") {
  const t = makeCtx(home, { lang });
  const code = await runPwm(["read", ...extra, ref], t.ctx);
  return { code, out: t.stdout(), err: t.stderr() };
}

describe("2. pwm read が各欄の正しい値を返す", () => {
  it("全部の欄(種類・環境・期限を含む)", async () => {
    const h = await makeHome(ITEMS);
    expect(await read(h.dir, "plain")).toMatchObject({ code: 0, out: `${CANARY_AUTOM}-plain\n` });
    expect((await read(h.dir, "plain/PASSWORD")).out).toBe(`${CANARY_AUTOM}-plain\n`);
    expect((await read(h.dir, "plain/username")).out).toBe("alice\n");
    expect((await read(h.dir, "plain/url")).out).toBe("https://plain.example.test/\n");
    expect((await read(h.dir, "plain/notes")).out).toBe("note text\n");
    expect((await read(h.dir, "plain/type")).out).toBe("password\n"); // 空は password と出す
    expect((await read(h.dir, "explicit/type")).out).toBe("password\n");
    expect((await read(h.dir, "plain/environment")).out).toBe("\n");
    expect((await read(h.dir, "plain/expires")).out).toBe("\n"); // 期限なしは空
    expect((await read(h.dir, "ApiKey/type")).out).toBe("apikey\n");
    expect((await read(h.dir, "ApiKey/environment")).out).toBe("production\n");
    expect((await read(h.dir, "ApiKey/expires")).out).toBe("2031-05-20\n");
    expect((await read(h.dir, "svc/prod/password")).out).toBe(`${CANARY_AUTOM}-slash\n`);
    expect((await read(h.dir, "svc/prod/username")).out).toBe("bob\n");
  });

  it("--no-newline は最後の改行を付けない", async () => {
    const h = await makeHome(ITEMS);
    expect((await read(h.dir, "plain/username", ["--no-newline"])).out).toBe("alice");
  });

  it("ごみ箱の中の項目は対象にしない。タイトルが2件以上あるときはエラー", async () => {
    const h = await makeHome([...ITEMS, { title: "dup", password: "x1" }, { title: "dup", password: "x2" }], {
      recycleBin: [{ title: "trashed", password: `${CANARY_AUTOM}-trash` }],
    });
    const trashed = await read(h.dir, "trashed");
    expect(trashed.code).not.toBe(0);
    expect(trashed.out).toBe("");
    const dup = await read(h.dir, "dup");
    expect(dup.code).not.toBe(0);
    expect(dup.err).toContain("2");
  });
});

describe("20. 失敗の表示に値・ユーザー名・URL・参照の文字列が入らない", () => {
  it("見つからない・知らない欄・2件以上", async () => {
    const h = await makeHome([...ITEMS, { title: "dup", password: "x1" }, { title: "dup", password: "x2" }]);
    for (const [ref, text] of [
      ["secret-missing-title/password", "secret-missing-title"],
      ["plain/secretfield", "secretfield"],
      ["dup", "dup"],
    ] as const) {
      const r = await read(h.dir, ref);
      expect(r.code).not.toBe(0);
      expect(r.out).toBe("");
      expect(r.err).not.toContain(text);
      for (const bad of ["alice", "bob", "plain.example.test", CANARY_AUTOM, CANARY_MAIN]) expect(r.err).not.toContain(bad);
      expect(hasMarker(r.err)).toBe(false);
    }
  });
});
