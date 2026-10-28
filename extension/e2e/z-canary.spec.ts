import { CANARY, PORT_A, appOrigin, appUrl, expect, test } from "./fixtures.ts";

// 設計書 §13-1 / 実装指示 4-4: テストの後で、次を探して本体用の目印が無いことを確かめる。
// (作業フォルダのファイルは `npm run scan:canary`、Chrome の一時プロファイルは worker の後始末で探す。)
// 値そのものは出さず、どこを見て何件だったかだけを出す。
test.describe.configure({ mode: "serial" });

test("chrome.storage.local の全体に目印が無い(トークンの平文も無い)", async ({ env }) => {
  const dump = await env.ext.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  const keys = await env.ext.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).sort());
  console.log(`[canary] chrome.storage.local: keys=${keys.join(",")} bytes=${dump.length}`);
  expect(dump.includes(CANARY)).toBe(false);
  // 置いてあるのは設定、トークン入れ(暗号化)、保管庫の暗号文、版、同期日時だけ
  expect(keys).toEqual(["lastSync", "settings", "tokenKdbx", "vaultCipher", "vaultVersion"]);
});

test("IndexedDB(拡張のオリジンとテストのページのオリジン)に目印が無い", async ({ env }) => {
  const scan = () =>
    (page: import("@playwright/test").Page) =>
      page.evaluate(async (canary) => {
        const dbs = await indexedDB.databases();
        let stores = 0;
        let found = 0;
        for (const info of dbs) {
          if (!info.name) continue;
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(info.name!);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          for (const name of Array.from(db.objectStoreNames)) {
            stores++;
            const all = await new Promise<unknown[]>((resolve, reject) => {
              const r = db.transaction(name).objectStore(name).getAll();
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
            if (JSON.stringify(all, (_k, v) => (v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)).join(",") : v)).includes(canary)) found++;
          }
          db.close();
        }
        return { databases: dbs.length, stores, found };
      }, CANARY);

  const extResult = await scan()(env.ext);
  const page = await env.newPage();
  await page.goto(appUrl("/login.html"));
  const pageResult = await scan()(page);
  await page.close();
  console.log(`[canary] IndexedDB extension: ${JSON.stringify(extResult)}; test page ${appOrigin.replace(String(PORT_A), "<A>")}: ${JSON.stringify(pageResult)}`);
  expect(extResult.found).toBe(0);
  expect(pageResult.found).toBe(0);
});

test("service worker、ポップアップ、テストのページのコンソールに目印が無い", async ({ env }) => {
  console.log(`[canary] console lines collected: ${env.consoleLines.length}`);
  expect(env.consoleLines.some((l) => l.includes(CANARY))).toBe(false);
});

test("wrangler dev の標準出力と標準エラーに目印が無い", async ({ env }) => {
  const out = env.wrangler.output();
  console.log(`[canary] wrangler output bytes: ${out.length}`);
  expect(out.length).toBeGreaterThan(0);
  expect(out.includes(CANARY)).toBe(false);
});
