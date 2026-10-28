import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { CANARY, PORT_A, appUrl, expect, test } from "./fixtures.ts";
import { TOKEN_ANDROID, putVault } from "./support.ts";

// 実装指示 4-3: Android(kotpass)が作った .kdbx を wrangler dev に PUT し、拡張で解除して、
// app.localhost でクリックなしに入力されること、API キーの項目は入らないことを確かめる。
// 先に Android 側で作る: PWV_EXT_VAULT_DIR と PWV_EXT_PORT_A を指定して
//   gradlew testDebugUnitTest --tests '*ExtensionVaultTest*'
const vaultDir = process.env.PWV_EXT_VAULT_DIR ?? path.join(os.tmpdir(), "pwv-ext-vault");
const vaultFile = path.join(vaultDir, "extension-vault.kdbx");
const ANDROID_MASTER = `extension-master-${CANARY}-dummy`;
const PW_LOGIN = `${CANARY}-ext-login`;
const PW_KEY = `${CANARY}-ext-key`;

const mark = (page: Page) => page.evaluate(() => document.documentElement.dataset.pwvAutofill ?? "");

test("4-3. Android 製の保管庫: クリックなしで入力され、API キーの項目は入らない", async ({ env }) => {
  expect(existsSync(vaultFile), "Android 側で extension-vault.kdbx を先に作ること").toBe(true);

  await putVault("android", TOKEN_ANDROID, new Uint8Array(await readFile(vaultFile)));
  await env.configureSync(TOKEN_ANDROID, "android", ANDROID_MASTER);
  await env.setOnload(true);
  await env.lock();

  // ポップアップの画面で解除する(Android 製の KDBX4: Argon2id 64MiB を hash-wasm で解く)
  const popup = await env.newPage();
  await popup.goto(`chrome-extension://${env.extId}/popup.html`);
  await popup.fill("#master", ANDROID_MASTER);
  await popup.click("#unlock");
  await expect(popup.locator("#lock")).toBeVisible({ timeout: 90_000 });

  // 項目が3件読めた(パスワード、API キー、別のサイト)。値は画面に出ない
  await expect(popup.locator(".item")).toHaveCount(3);
  expect((await popup.locator("body").innerText()).includes(CANARY)).toBe(false);

  // app.localhost: クリックなしで入力される
  const page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  await expect.poll(() => mark(page), { timeout: 30_000 }).toMatch(/^(filled|declined)$/);
  expect(await mark(page)).toBe("filled");
  const pw = await page.locator("#pw").inputValue();
  expect(pw === PW_LOGIN).toBe(true);
  expect(pw === PW_KEY).toBe(false); // API キーの値は入っていない
  expect((await page.locator("#user").inputValue()) === "ext-user").toBe(true);

  // 別のオリジンでは入らない
  const other = await env.newPage();
  await other.goto(env.url("app2.localhost", PORT_A, "/login.html"));
  await expect.poll(() => mark(other), { timeout: 30_000 }).toMatch(/^declined$/);
  expect(await other.locator("#pw").inputValue()).toBe("");

  // ポップアップ: API キーの項目に『入力』は出ず、コピーだけが出る
  await page.bringToFront();
  await popup.reload();
  const card = (title: string) => popup.locator(".item", { hasText: title }).first();
  await expect(card("Extension Test Login").locator('[data-action="fill"]')).toHaveCount(1);
  await expect(card("Extension Hidden Api Key").locator('[data-action="fill"]')).toHaveCount(0);
  await expect(card("Extension Hidden Api Key").locator('[data-action="breach"]')).toHaveCount(0);
  await expect(card("Extension Hidden Api Key").locator('[data-action="copy-password"]')).toHaveCount(1);
  await expect(card("Extension Other Site").locator('[data-action="fill"]')).toHaveCount(0);

  await popup.close();
  await page.close();
  await other.close();
});
