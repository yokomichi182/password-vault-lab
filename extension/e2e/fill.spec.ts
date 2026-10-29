import type { Page } from "@playwright/test";
import { access } from "node:fs/promises";
import path from "node:path";
import { CANARY, appOrigin, appUrl, expect, test, type Env } from "./fixtures.ts";
import { REAL_REG_KEYS, REG_KEY, RawMcp, bridgeFiles, regKeyExists, runPwmFill } from "./nativeHost.ts";
import type { FakeItem } from "./support.ts";

// 設計書 §13-4 の経路 B(実装指示_フェーズ5 の 4-2): 実際の pwm fill / pwm-mcp → つなぎの置き場 → Native Messaging のホスト pwm-bridge → 拡張 → ページ。
// 入力したかどうかは欄の値で確かめ、値そのものは出力しない。
test.describe.configure({ mode: "serial" });

const PW_APP = `${CANARY}-fill-app-pw`;
const loginApp: FakeItem = { id: 1, title: "App Login", username: "app-user", password: PW_APP, url: appOrigin };
const loginOther: FakeItem = { id: 2, title: "Other Login", username: "other-user", password: `${CANARY}-fill-other-pw`, url: "https://other.example.test" };
const apiKeyApp: FakeItem = { id: 3, title: "App Api Key", username: "key-id", password: `${CANARY}-fill-key-pw`, url: appOrigin, itemType: "apikey" };

const filledWith = async (page: Page, sel: string, expected: string) => (await page.locator(sel).inputValue()) === expected;
const isEmpty = async (page: Page, sel: string) => (await page.locator(sel).inputValue()) === "";

async function setApprovals(env: Env, origins: string[]): Promise<void> {
  await env.ext.evaluate(async (list) => {
    await chrome.storage.local.set({ approvals: list.map((origin) => ({ origin, at: new Date().toISOString() })) });
  }, origins);
}

async function getApprovals(env: Env): Promise<{ origin: string; at: string }[]> {
  return env.ext.evaluate(async () => ((await chrome.storage.local.get("approvals")) as { approvals?: { origin: string; at: string }[] }).approvals ?? []);
}

/** 入力の対象にするページを開いて、いちばん前にする(最後にフォーカスした通常の窓の、表示中のタブにする)。 */
async function openApp(env: Env, path = "/login.html"): Promise<Page> {
  const page = await env.newPage();
  await page.goto(appUrl(path));
  await page.waitForFunction(() => document.documentElement.dataset.pwvAutofill !== undefined, undefined, { timeout: 30_000 }); // コンテンツスクリプトが動いた
  await page.bringToFront();
  return page;
}

/** 承認画面(拡張のページ approve.html の窓)が出るのを待つ。fill を始める前に呼んでおく。 */
function waitApprovalWindow(env: Env): Promise<Page> {
  return env.context.waitForEvent("page", { timeout: 30_000 }).then(async (p) => {
    await p.waitForURL(/approve\.html/, { timeout: 30_000 });
    return p;
  });
}

test.beforeAll(async ({ env }) => {
  // 本物の名前(com.pwm.bridge)は登録されていない。テスト用の名前だけが、このテストのあいだ登録されている
  expect(regKeyExists(REG_KEY)).toBe(true);
  for (const k of REAL_REG_KEYS) expect(regKeyExists(k), k).toBe(false);
  await env.setVault([loginApp, loginOther, apiKeyApp]);
  await env.configureSync();
  await env.unlock();
  // ホストが起動した(拡張が connectNative でつないだ)ことを待つ。pwm-bridge は起動すると置き場を作る
  const bridgeDir = path.join(env.native.home, "bridge");
  await expect
    .poll(async () => access(bridgeDir).then(() => true, () => false), { timeout: 60_000, message: "pwm-bridge did not start (native messaging)" })
    .toBe(true);
});

test.beforeEach(async ({ env }) => {
  await env.setOnload(false); // オンロード自動入力が先に入れてしまわないように
  await env.unlock();
  await setApprovals(env, []);
});

test("1. 承認済みオリジンで request_fill: 承認画面なしで入力する(filled)", async ({ env }) => {
  await setApprovals(env, [appOrigin]);
  const page = await openApp(env);
  const before = env.context.pages().length;
  const r = await runPwmFill(env.native.home, "App Login").done;
  expect(r.stdout).toBe("filled\n");
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
  expect(await filledWith(page, "#pw", PW_APP)).toBe(true);
  expect(await filledWith(page, "#user", "app-user")).toBe(true);
  expect(env.context.pages().length).toBe(before); // 承認画面は出ていない
  expect(await bridgeFiles(env.native.home)).toEqual([]); // 依頼と応答のファイルは残らない
  await page.close();
});

test("2. 承認していないオリジン: 承認画面が出る。承認すると入力して(filled)承認リストに足す。次からは承認画面なし", async ({ env }) => {
  const page = await openApp(env);
  const popupP = waitApprovalWindow(env);
  const run = runPwmFill(env.native.home, "App Login");
  const popup = await popupP;
  // 承認画面: サイトのオリジン、項目名、ユーザー名の一部、要求した AI の名前(自己申告)。値は出ない
  await expect(popup.locator("#approve-rows")).toContainText(appOrigin);
  await expect(popup.locator("#approve-rows")).toContainText("App Login");
  await expect(popup.locator("#approve-rows")).toContainText("ap…");
  await expect(popup.locator("#approve-rows")).toContainText("pwm fill (CLI)");
  const text = await popup.locator("body").innerText();
  expect(text.includes(PW_APP) || text.includes("app-user")).toBe(false);
  // 既定は拒否(フォーカス)
  expect(await popup.evaluate(() => document.activeElement?.id)).toBe("approve-deny");
  expect(await isEmpty(page, "#pw")).toBe(true); // 承認するまで入力されていない
  await popup.click("#approve-allow");
  const r = await run.done;
  expect(r.stdout).toBe("filled\n");
  expect(await filledWith(page, "#pw", PW_APP)).toBe(true);
  expect(await filledWith(page, "#user", "app-user")).toBe(true);
  const saved = await getApprovals(env);
  expect(saved.map((a) => a.origin)).toEqual([appOrigin]);
  expect(Object.keys(saved[0]!).sort()).toEqual(["at", "origin"]); // オリジンと時刻だけ
  await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);

  // 2回目は承認画面なし
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.pwvAutofill !== undefined);
  await page.bringToFront();
  const pagesBefore = env.context.pages().length;
  const r2 = await runPwmFill(env.native.home, "App Login").done;
  expect(r2.stdout).toBe("filled\n");
  expect(await filledWith(page, "#pw", PW_APP)).toBe(true);
  expect(env.context.pages().length).toBe(pagesBefore);
  await page.close();
});

test("3. 承認していないオリジンで「拒否」・窓を閉じる: 入力せず denied。承認リストに足さない", async ({ env }) => {
  const page = await openApp(env);
  for (const how of ["deny", "close"] as const) {
    const popupP = waitApprovalWindow(env);
    const run = runPwmFill(env.native.home, "App Login");
    const popup = await popupP;
    if (how === "deny") await popup.click("#approve-deny");
    else await popup.close({ runBeforeUnload: false });
    const r = await run.done;
    expect(r.stdout, how).toBe("denied\n");
    expect(r.code).toBe(1);
    expect(await isEmpty(page, "#pw"), how).toBe(true);
    expect(await isEmpty(page, "#user"), how).toBe(true);
    expect(await getApprovals(env), how).toEqual([]);
    await page.bringToFront();
  }
  await page.close();
});

test("4. 承認画面を放っておく: 55秒で閉じて拒否(denied)になる", async ({ env }) => {
  test.setTimeout(150_000);
  const page = await openApp(env);
  const popupP = waitApprovalWindow(env);
  const t0 = Date.now();
  const run = runPwmFill(env.native.home, "App Login");
  const popup = await popupP;
  const r = await run.done;
  const secs = (Date.now() - t0) / 1000;
  expect(r.stdout).toBe("denied\n");
  expect(secs).toBeGreaterThan(50);
  expect(secs).toBeLessThan(60);
  await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await getApprovals(env)).toEqual([]);
  await page.close();
});

test("5. AI が偽の URL を渡し、実際のタブが別オリジン: 入力せず not_found(実際のタブのオリジンで照合する)", async ({ env }) => {
  await setApprovals(env, [appOrigin, "https://other.example.test"]);
  const page = await openApp(env);
  // 実際のタブは app.localhost。AI は other.example.test のタブだと言う
  const a = await runPwmFill(env.native.home, "Other Login", "https://other.example.test/login").done;
  expect(a.stdout).toBe("not_found\n");
  // 実際のタブに合う項目名でも、AI の URL が違えば入力しない
  const b = await runPwmFill(env.native.home, "App Login", "https://other.example.test/login").done;
  expect(b.stdout).toBe("not_found\n");
  // URL を渡さず、他のオリジンの項目名だけを言っても、実際のタブには合わない
  const c = await runPwmFill(env.native.home, "Other Login").done;
  expect(c.stdout).toBe("not_found\n");
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await isEmpty(page, "#user")).toBe(true);
  // 実際のタブと同じオリジンの URL を渡したときは入力する
  const d = await runPwmFill(env.native.home, "App Login", `${appOrigin}/login.html`).done;
  expect(d.stdout).toBe("filled\n");
  expect(await filledWith(page, "#pw", PW_APP)).toBe(true);
  await page.close();
});

test("6. 対象が API キーの項目: 承認済みのオリジンでも入力せず not_found。承認画面も出ない", async ({ env }) => {
  await setApprovals(env, [appOrigin]);
  const page = await openApp(env);
  const pagesBefore = env.context.pages().length;
  const r = await runPwmFill(env.native.home, "App Api Key").done;
  expect(r.stdout).toBe("not_found\n");
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await isEmpty(page, "#user")).toBe(true);
  expect(env.context.pages().length).toBe(pagesBefore);
  await page.close();
});

test("7. ロック中: locked(入力しない・承認画面も出ない)", async ({ env }) => {
  await setApprovals(env, [appOrigin]);
  const page = await openApp(env);
  await env.lock();
  const r = await runPwmFill(env.native.home, "App Login").done;
  expect(r.stdout).toBe("locked\n");
  expect(await isEmpty(page, "#pw")).toBe(true);
  await page.close();
});

test("8. 承認画面のあいだにタブを切り替えた: 承認しても入力せず not_found。承認リストにも足さない", async ({ env }) => {
  const page = await openApp(env);
  const popupP = waitApprovalWindow(env);
  const run = runPwmFill(env.native.home, "App Login");
  const popup = await popupP;
  const other = await env.newPage();
  await other.goto(appUrl("/login.html?other=1"));
  await other.bringToFront(); // 別のタブ(別のページ)が表示中になる
  await popup.click("#approve-allow");
  const r = await run.done;
  expect(r.stdout).toBe("not_found\n");
  expect(await isEmpty(page, "#pw")).toBe(true);
  expect(await isEmpty(other, "#pw")).toBe(true);
  expect(await getApprovals(env)).toEqual([]);
  await other.close();
  await page.close();
});

test("9. 入力してよくないページ(http の 127.0.0.1)が前面にあるとき: not_found", async ({ env }) => {
  await setApprovals(env, [appOrigin]);
  const page = await env.newPage();
  await page.goto(`http://127.0.0.1:${new URL(appOrigin).port}/login.html`);
  await page.bringToFront();
  const r = await runPwmFill(env.native.home, "App Login").done;
  expect(r.stdout).toBe("not_found\n");
  expect(await isEmpty(page, "#pw")).toBe(true);
  await page.close();
});

test("10. MCP の request_fill(実際の pwm-mcp を標準入出力で動かす): 承認済みなら filled。結果は語だけで、値が会話に出ない", async ({ env }) => {
  await setApprovals(env, [appOrigin]);
  const page = await openApp(env);
  const mcp = new RawMcp(env.native.home);
  try {
    await mcp.init();
    const list = await mcp.request("tools/list", {});
    const names = ((list.result as unknown as { tools: { name: string }[] }).tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["audit", "list_titles", "read_credential", "request_credential", "request_fill", "run"]);
    const out = await mcp.tool("request_fill", { title: "App Login" });
    expect(JSON.parse(out)).toEqual({ result: "filled" });
    expect(await filledWith(page, "#pw", PW_APP)).toBe(true);
    // 偽の URL を渡す
    const fake = await mcp.tool("request_fill", { title: "App Login", url: "https://other.example.test/" });
    expect(JSON.parse(fake)).toEqual({ result: "not_found" });
    // pwm-mcp の標準出力と標準エラーに、値・項目名・ユーザー名が出ない(標準エラーは結果の種類だけ)
    expect(mcp.stdout.includes(PW_APP) || mcp.stdout.includes("app-user")).toBe(false);
    expect(mcp.stderr).toContain("pwm-mcp: request_fill filled");
    expect(mcp.stderr.includes("App Login") || mcp.stderr.includes(PW_APP)).toBe(false);
  } finally {
    await mcp.close();
  }
  await page.close();
});

test("11. 設定画面の承認リスト: オリジンと時刻だけを一覧に出し、1件ずつ確認つきで削除できる", async ({ env }) => {
  await setApprovals(env, [appOrigin, "https://shop.example.test"]);
  await env.ext.goto(`chrome-extension://${env.extId}/options.html`);
  const rows = env.ext.locator("#approvals-list .approval-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(appOrigin);
  await expect(rows.nth(1)).toContainText("https://shop.example.test");
  // 確認で「キャンセル」したら消えない
  env.ext.once("dialog", (d) => void d.dismiss());
  await rows.nth(0).locator(".approval-remove").click();
  await expect(rows).toHaveCount(2);
  expect((await getApprovals(env)).map((a) => a.origin)).toEqual([appOrigin, "https://shop.example.test"]);
  // 確認で「OK」したら、その1件だけ消える
  env.ext.once("dialog", (d) => void d.accept());
  await rows.nth(0).locator(".approval-remove").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("https://shop.example.test");
  expect((await getApprovals(env)).map((a) => a.origin)).toEqual(["https://shop.example.test"]);
  env.ext.once("dialog", (d) => void d.accept());
  await rows.nth(0).locator(".approval-remove").click();
  await expect(env.ext.locator("#approvals-empty")).toBeVisible();
  expect(await getApprovals(env)).toEqual([]);
});

test("12. 承認リストはオンロード自動入力に効かない(承認済みでも、オンロードをオフにしていれば自動では入らない)", async ({ env }) => {
  await setApprovals(env, [appOrigin]);
  await env.setOnload(false);
  const page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  await page.waitForFunction(() => document.documentElement.dataset.pwvAutofill !== undefined);
  await page.waitForTimeout(1500);
  expect(await isEmpty(page, "#pw")).toBe(true);
  await page.close();
});

test("13. 後片付けの確認: つなぎの置き場に依頼・応答のファイルが残っていない", async ({ env }) => {
  expect((await bridgeFiles(env.native.home)).filter((n) => /^(req|res)-/.test(n))).toEqual([]);
});
