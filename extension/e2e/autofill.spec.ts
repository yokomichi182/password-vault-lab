import type { Page } from "@playwright/test";
import { CANARY, PORT_A, PORT_B, MASTER, appOrigin, appUrl, expect, test, type Env } from "./fixtures.ts";
import type { FakeItem } from "./support.ts";
import { sha1Upper } from "./support.ts";

// 設計書 §13-3 と実装指示 4-2 の 1〜16。入力したかどうかは欄の値で確かめ、値そのものは出力しない。
test.describe.configure({ mode: "serial" });

const PW_APP = `${CANARY}-app-pw`;
const loginApp: FakeItem = { id: 1, title: "App Login", username: "app-user", password: PW_APP, url: appOrigin };
const otherLogin: FakeItem = { id: 2, title: "Other Login", username: "other-user", password: `${CANARY}-other-pw`, url: "https://other.example.test" };
const apiKeyApp: FakeItem = { id: 3, title: "App Api Key", username: "key-id", password: `${CANARY}-key-pw`, url: appOrigin, itemType: "apikey" };
const noteApp: FakeItem = { id: 4, title: "App Note", username: "note-user", password: `${CANARY}-note-pw`, url: appOrigin, itemType: "note" };

const mark = (page: Page) => page.evaluate(() => document.documentElement.dataset.pwvAutofill ?? "");
const waitMark = async (page: Page, re: RegExp) => {
  await expect.poll(() => mark(page), { timeout: 30_000 }).toMatch(re);
};
/** 欄の値が期待のパスワードか(値そのものは出さない) */
const isFilledWith = async (page: Page, sel: string, expected: string) => (await page.locator(sel).inputValue()) === expected;
const isEmpty = async (page: Page, sel: string) => (await page.locator(sel).inputValue()) === "";

test.beforeAll(async ({ env }) => {
  await env.setVault([loginApp]);
  await env.configureSync();
  await env.setOnload(true);
  await env.unlock();
});

test.beforeEach(async ({ env }) => {
  await env.setOnload(true);
});

test("1. 保存したオリジンと同じページ: 入力する", async ({ env }) => {
  await env.setVault([loginApp]);
  await env.unlock();
  const page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  await waitMark(page, /^filled$/);
  expect(await isFilledWith(page, "#pw", PW_APP)).toBe(true);
  expect((await page.locator("#user").inputValue()) === "app-user").toBe(true);
  await page.close();
});

test("2. 2秒後にフォームが出るページ: 入力する", async ({ env }) => {
  const page = await env.newPage();
  await page.goto(appUrl("/delayed.html?ms=2000"));
  await waitMark(page, /^filled$/);
  expect(await isFilledWith(page, "#pw", PW_APP)).toBe(true);
  await page.close();
});

test("3. 11秒後にフォームが出るページ: 入力しない", async ({ env }) => {
  const page = await env.newPage();
  await page.goto(appUrl("/delayed.html?ms=11000"));
  await waitMark(page, /^gave-up$/);
  await expect(page.locator("#pw")).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await isEmpty(page, "#user")).toBe(true);
  expect(await mark(page)).toBe("gave-up");
  await page.close();
});

test("4. ポート違い、サブドメイン違い、似た名前のホスト: 入力しない", async ({ env }) => {
  const targets = [
    env.url("app.localhost", PORT_B, "/login.html"), // ポート違い
    env.url("sub.app.localhost", PORT_A, "/login.html"), // サブドメイン違い
    env.url("app2.localhost", PORT_A, "/login.html"), // 似た名前
    env.url("xapp.localhost", PORT_A, "/login.html"), // 似た名前
    env.url("app.localhost.localhost", PORT_A, "/login.html"), // 似た名前(後ろに足したホスト)
  ];
  for (const u of targets) {
    const page = await env.newPage();
    await page.goto(u);
    await waitMark(page, /^declined$/); // コンテンツスクリプトは動き、service worker が候補を返さなかった
    expect(await isEmpty(page, "#pw"), u.replace(/:\d+/, "")).toBe(true);
    expect(await isEmpty(page, "#user")).toBe(true);
    await page.close();
  }
});

test("5. http://127.0.0.1(localhost 以外の http): 入力しない", async ({ env }) => {
  const page = await env.newPage();
  await page.goto(`http://127.0.0.1:${PORT_A}/login.html`);
  await page.waitForTimeout(2500);
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await isEmpty(page, "#user")).toBe(true);
  // 拡張の matches に入らないので、コンテンツスクリプトそのものが動いていない
  expect(await mark(page)).toBe("");
  await page.close();
});

test("6. 一致するページの中の iframe のフォーム: iframe の中に入力しない", async ({ env }) => {
  const page = await env.newPage();
  await page.goto(appUrl("/iframe-parent.html"));
  await waitMark(page, /^gave-up$/); // 親にはフォームが無い
  const inner = page.frames().find((f) => f !== page.mainFrame());
  expect(inner).toBeTruthy();
  await inner!.waitForSelector("#pw");
  expect(await inner!.locator("#pw").inputValue()).toBe("");
  expect(await inner!.locator("#user").inputValue()).toBe("");
  await page.close();
});

test("7. 見えない欄: 入力しない", async ({ env }) => {
  const variants = [
    "display-none",
    "visibility-hidden",
    "zero-size",
    "offscreen",
    "hidden-ancestor",
    "hidden-attribute",
    "clipped-ancestor",
    "opacity-zero",
    "readonly",
    "disabled",
  ];
  const pages = await Promise.all(
    variants.map(async (v) => {
      const page = await env.newPage();
      await page.goto(appUrl(`/hidden.html?v=${v}`));
      return { v, page };
    }),
  );
  for (const { v, page } of pages) {
    await waitMark(page, /^gave-up$/);
    expect(await page.locator("#pw").inputValue() === "", v).toBe(true);
    expect(await page.locator("#user").inputValue() === "", v).toBe(true);
  }
  for (const { page } of pages) await page.close();
});

test("8. ロック中、オンロードをオフにした設定、セッションの時間切れ: 入力しない", async ({ env }) => {
  // ロック中
  await env.lock();
  let page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  await waitMark(page, /^declined$/);
  expect(await isEmpty(page, "#pw")).toBe(true);
  await page.close();

  // オンロードをオフ
  await env.unlock();
  await env.setOnload(false);
  page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  await waitMark(page, /^declined$/);
  expect(await isEmpty(page, "#pw")).toBe(true);
  await page.close();
  await env.setOnload(true);

  // セッションの時間切れ(alarm が遅れた状況を、期限を過去にして再現する)
  await env.unlock();
  await env.ext.evaluate(async () => {
    const raw = (await chrome.storage.session.get("session")) as { session: Record<string, unknown> };
    await chrome.storage.session.set({ session: { ...raw.session, expiresAt: Date.now() - 1 } });
  });
  page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  await waitMark(page, /^declined$/);
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await env.sessionKeys()).toEqual([]); // 期限を過ぎたセッションは空にされた
  await page.close();
});

test("9. 同じオリジンの項目が API キー、または知らない種類: 入力しない", async ({ env }) => {
  await env.setVault([apiKeyApp, noteApp]);
  await env.unlock();
  const page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  await waitMark(page, /^declined$/);
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await isEmpty(page, "#user")).toBe(true);
  await page.close();
});

test("10. 同じオリジンのログイン用の項目が2件: 自動では入力せず、バッジに 2", async ({ env }) => {
  await env.setVault([loginApp, { ...loginApp, id: 5, title: "App Login 2", username: "app-user-2", password: `${CANARY}-app-pw-2` }]);
  await env.unlock();
  const page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  await waitMark(page, /^declined$/);
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await isEmpty(page, "#user")).toBe(true);
  await page.bringToFront();
  await expect
    .poll(() =>
      env.ext.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return chrome.action.getBadgeText({ tabId: tab!.id! });
      }),
    )
    .toBe("2");
  await page.close();
});

test("11. autocomplete=new-password の欄だけのページ: 入力しない", async ({ env }) => {
  await env.setVault([loginApp]);
  await env.unlock();
  const page = await env.newPage();
  await page.goto(appUrl("/new-password.html"));
  await waitMark(page, /^gave-up$/); // 対象の欄が無いので 10 秒待って諦める
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await isEmpty(page, "#pw2")).toBe(true);
  expect(await isEmpty(page, "#user")).toBe(true);
  await page.close();
});

test("12. 入力したあとに利用者が消し、フォームを入れ直したページ: もう一度は入力しない", async ({ env }) => {
  const page = await env.newPage();
  await page.goto(appUrl("/reinsert.html"));
  await waitMark(page, /^filled$/);
  expect(await isFilledWith(page, "#pw", PW_APP)).toBe(true);
  await page.evaluate(() => {
    (document.getElementById("pw") as HTMLInputElement).value = "";
    (document.getElementById("user") as HTMLInputElement).value = "";
    (window as unknown as { reinsert: () => void }).reinsert();
  });
  await page.waitForTimeout(2000);
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await isEmpty(page, "#user")).toBe(true);
  await page.close();
});

test("13. コンテンツスクリプトから chrome.storage.session を読む: 読めない", async ({ env }) => {
  const page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  await waitMark(page, /^(filled|declined)$/);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.pwvSessionProbe ?? ""))
    .toBe("denied");
  await page.close();
});

/** 今のタブ(対象のページ)が前面にあるときにポップアップを開く。実際のポップアップはタブではないので、前面のタブが「今のタブ」になる。 */
async function openPopupFor(env: Env, target: Page): Promise<Page> {
  const popup = await env.newPage();
  await popup.goto(`chrome-extension://${env.extId}/popup.html`);
  await target.bringToFront();
  await popup.reload();
  return popup;
}

test("14. ポップアップの『入力』: 一致する項目では入る。一致しない項目には出ない", async ({ env }) => {
  await env.setVault([loginApp, otherLogin, apiKeyApp]);
  await env.unlock();
  await env.setOnload(false); // 自動入力が先に入れないようにして、ポップアップの動作だけを確かめる
  const target = await env.newPage();
  await target.goto(appUrl("/login.html"));
  await waitMark(target, /^declined$/);
  expect(await isEmpty(target, "#pw")).toBe(true);

  const popup = await openPopupFor(env, target);
  await expect(popup.locator('[data-id]').first()).toBeVisible();
  const idOf = async (title: string) => (await popup.locator(".item", { hasText: title }).first().getAttribute("data-id"))!;
  const idLogin = await idOf("App Login");
  const idOther = await idOf("Other Login");
  const idKey = await idOf("App Api Key");
  // 一致するログイン用の項目だけに『入力』が出る(API キーは種類を問わずコピーだけ)
  await expect(popup.locator(`[data-id="${idLogin}"] [data-action="fill"]`)).toHaveCount(1);
  await expect(popup.locator(`[data-id="${idOther}"] [data-action="fill"]`)).toHaveCount(0);
  await expect(popup.locator(`[data-id="${idKey}"] [data-action="fill"]`)).toHaveCount(0);
  await expect(popup.locator(`[data-id="${idKey}"] [data-action="copy-password"]`)).toHaveCount(1);
  // 値は画面に出ない
  expect((await popup.locator("body").innerText()).includes(CANARY)).toBe(false);

  await popup.locator(`[data-id="${idLogin}"] [data-action="fill"]`).click();
  await expect.poll(() => isFilledWith(target, "#pw", PW_APP)).toBe(true);
  expect((await target.locator("#user").inputValue()) === "app-user").toBe(true);
  await popup.close();
  await target.close();
});

test("15. ポップアップの漏洩チェック(ローカルのモック)", async ({ env }) => {
  const cleanLogin: FakeItem = { id: 6, title: "Clean Login", username: "clean-user", password: `${CANARY}-clean-pw`, url: "https://clean.example.test" };
  await env.setVault([loginApp, apiKeyApp, cleanLogin]);
  await env.unlock();
  await env.setOnload(false);
  env.breach.add(sha1Upper(PW_APP), 7);
  env.breach.requests.length = 0;

  const target = await env.newPage();
  await target.goto(appUrl("/login.html"));
  await waitMark(target, /^declined$/);
  const popup = await openPopupFor(env, target);
  await expect(popup.locator("[data-id]").first()).toBeVisible();
  const card = (title: string) => popup.locator(".item", { hasText: title }).first();

  // API キーの項目にはボタンが出ない
  await expect(card("App Api Key").locator('[data-action="breach"]')).toHaveCount(0);

  // 漏洩済みの項目: 警告と回数
  await card("App Login").locator('[data-action="breach"]').click();
  await expect(card("App Login").locator(".result")).toHaveText("Leaked (7 times)");
  // 送ったのは先頭5文字だけで、Add-Padding が付いていた
  expect(env.breach.requests.length).toBe(1);
  expect(env.breach.requests[0]!.path).toMatch(/^\/range\/[0-9A-F]{5}$/i);
  expect(env.breach.requests[0]!.padding).toBe("true");

  // 一致しない項目: 漏洩なし
  await card("Clean Login").locator('[data-action="breach"]').click();
  await expect(card("Clean Login").locator(".result")).toHaveText("Not found in known leaks.");

  // モックを止める: 『確かめられませんでした』(漏洩なしと出さない)
  await env.breach.stop();
  await card("App Login").locator('[data-action="breach"]').click();
  await expect(card("App Login").locator(".result")).toHaveText("Could not check.");
  await env.breach.start();

  await popup.close();
  await target.close();
});

test("16. マスターパスワードの誤り: 解除しない。chrome.storage.session は空のまま", async ({ env }) => {
  await env.lock();
  expect(await env.sessionKeys()).toEqual([]);
  const popup = await env.newPage();
  await popup.goto(`chrome-extension://${env.extId}/popup.html`);
  await popup.fill("#master", `${MASTER}-wrong`);
  await popup.click("#unlock");
  await expect(popup.locator("#msg")).toHaveText("Wrong master password.");
  expect(await env.sessionKeys()).toEqual([]);
  // ロック中の画面のまま
  await expect(popup.locator("#master")).toBeVisible();
  // 正しいパスワードでは解除できる
  await popup.fill("#master", MASTER);
  await popup.click("#unlock");
  await expect(popup.locator("#lock")).toBeVisible({ timeout: 60_000 });
  expect((await env.sessionKeys()).length).toBe(1);
  await popup.close();
});

test("追加. 『パスワードをコピー』で貼り付けられ、30 秒後にクリップボードが消える", async ({ env }) => {
  await env.setVault([loginApp]);
  await env.unlock();
  await env.setOnload(false);
  const target = await env.newPage();
  await target.goto(appUrl("/login.html"));
  await waitMark(target, /^declined$/);
  const popup = await openPopupFor(env, target);
  const card = popup.locator(".item", { hasText: "App Login" }).first();
  await expect(card).toBeVisible();
  await card.locator('[data-action="copy-password"]').click();
  await expect(card.locator(".result")).toContainText("Copied.");

  // 貼り付けて、コピーした値か確かめる(値そのものは出さない)
  const paste = async () => {
    await target.evaluate(() => ((document.getElementById("user") as HTMLInputElement).value = ""));
    await target.locator("#user").focus();
    await target.keyboard.press("Control+V");
    return target.locator("#user").inputValue();
  };
  expect((await paste()) === PW_APP).toBe(true);

  // 30 秒後に空白で上書きされる
  await expect.poll(async () => (await paste()).trim(), { timeout: 90_000, intervals: [3000] }).toBe("");
  await popup.close();
  await target.close();
});
