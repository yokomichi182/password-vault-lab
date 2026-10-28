import { describe, expect, it } from "vitest";
import { isFillableOrigin, isLoginType, itemOrigin, matchItems } from "../src/shared/match.ts";
import { CANARY } from "./canary.ts";

const item = (url: string, itemType = "") => ({ url, itemType, title: "t" });

describe("照合: 動くこと", () => {
  it("1. 同じオリジンに一致する(既定のポート表記、大文字のホスト、スキームなしの URL を含む)", () => {
    const page = "https://app.example.test";
    expect(matchItems([item("https://app.example.test")], page)).toHaveLength(1);
    expect(matchItems([item("https://app.example.test/login?x=1")], page)).toHaveLength(1);
    expect(matchItems([item("https://app.example.test:443")], page)).toHaveLength(1);
    expect(matchItems([item("https://APP.Example.TEST")], page)).toHaveLength(1);
    expect(matchItems([item("app.example.test")], page)).toHaveLength(1);
    expect(matchItems([item("app.example.test/path")], page)).toHaveLength(1);
    expect(matchItems([item("http://app.localhost:8080")], "http://app.localhost:8080")).toHaveLength(1);
    expect(matchItems([item("app.example.test:8443")], "https://app.example.test:8443")).toHaveLength(1);
  });

  it("2. 種類の判定: 空と password はログイン用", () => {
    expect(isLoginType("")).toBe(true);
    expect(isLoginType("password")).toBe(true);
    expect(isLoginType("apikey")).toBe(false);
    expect(isLoginType("note")).toBe(false);
    expect(isLoginType("Password")).toBe(false);
  });
});

describe("照合: 動いてはいけない所で動かない", () => {
  const page = "https://app.example.test";
  it("5. ポート違い、サブドメイン違い、似た名前のホスト、スキーム違いは一致しない", () => {
    for (const url of [
      "https://app.example.test:8443",
      "https://sub.app.example.test",
      "https://example.test",
      "https://app.example.test.evil.test",
      "https://appexample.test",
      "https://xapp.example.test",
      "http://app.example.test",
    ]) {
      expect(matchItems([item(url)], page), url).toHaveLength(0);
    }
    expect(matchItems([item("https://app.example.test")], "https://app.example.test:8443")).toHaveLength(0);
    expect(matchItems([item("https://app.example.test")], "http://app.example.test")).toHaveLength(0);
  });

  it("6. API キーと知らない種類は一致しない。androidapp:// の項目も一致しない", () => {
    expect(matchItems([item("https://app.example.test", "apikey")], page)).toHaveLength(0);
    expect(matchItems([item("https://app.example.test", "note")], page)).toHaveLength(0);
    expect(matchItems([item("androidapp://dev.example.app")], page)).toHaveLength(0);
    expect(matchItems([item("androidapp://app.example.test")], page)).toHaveLength(0);
    expect(itemOrigin("androidapp://dev.example.app")).toBeNull();
  });

  it("解釈できない URL・空の URL・http と https 以外は対象にしない", () => {
    for (const url of ["", "   ", "http://", "javascript:alert(1)", "ftp://app.example.test", "https://[::1"]) {
      expect(matchItems([item(url)], page), url).toHaveLength(0);
    }
    expect(matchItems([item("https://app.example.test")], "not a url")).toHaveLength(0);
    expect(matchItems([item("https://app.example.test")], "file:///C:/x.html")).toHaveLength(0);
  });

  it("7. 入力してよいページの判定", () => {
    expect(isFillableOrigin("http://127.0.0.1")).toBe(false);
    expect(isFillableOrigin("http://127.0.0.1:8080")).toBe(false);
    expect(isFillableOrigin("http://example.test")).toBe(false);
    expect(isFillableOrigin("http://notlocalhost")).toBe(false);
    expect(isFillableOrigin("http://localhost.evil.test")).toBe(false);
    expect(isFillableOrigin("file:///C:/x.html")).toBe(false);
    expect(isFillableOrigin("chrome://settings")).toBe(false);
    expect(isFillableOrigin("chrome-extension://abc")).toBe(false);
    expect(isFillableOrigin("null")).toBe(false);
    expect(isFillableOrigin("")).toBe(false);
    expect(isFillableOrigin("http://localhost:8080")).toBe(true);
    expect(isFillableOrigin("http://a.localhost:8080")).toBe(true);
    expect(isFillableOrigin("http://A.LOCALHOST:8080")).toBe(true);
    expect(isFillableOrigin("https://app.example.test")).toBe(true);
  });

  it("9. 目印を含む項目を通しても、例外のメッセージに目印が入らない", () => {
    const hostile = [
      `https://${CANARY}:badport`,
      `${CANARY}`,
      `https://${CANARY}.example.test`,
      `androidapp://${CANARY}`,
      `https://[${CANARY}`,
    ];
    const pages = [`https://${CANARY}.example.test`, `https://[${CANARY}`, CANARY];
    for (const url of hostile) {
      for (const p of pages) {
        try {
          matchItems([{ url, itemType: "", title: CANARY }], p);
          isFillableOrigin(p);
          itemOrigin(url);
        } catch (e) {
          expect(String((e as Error).message)).not.toContain(CANARY);
        }
      }
    }
  });
});
