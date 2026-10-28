import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium, expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import {
  BreachMock,
  CANARY,
  MASTER,
  PORT_A,
  PORT_B,
  SYNC_URL,
  TOKEN_MAIN,
  close,
  dirContainsBytes,
  makeVault,
  putVault,
  startPageServers,
  startWrangler,
  type FakeItem,
  type Wrangler,
} from "./support.ts";

const dist = path.resolve(import.meta.dirname, "..", "dist");

function chromiumPath(): string {
  if (process.env.PWV_CHROMIUM) return process.env.PWV_CHROMIUM;
  // 導入済みの Chromium(ダウンロードはしない)
  return path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1243", "chrome-win64", "chrome.exe");
}

export interface Env {
  context: BrowserContext;
  extId: string;
  profileDir: string;
  breach: BreachMock;
  wrangler: Wrangler;
  /** すべてのページ、service worker、拡張ページのコンソール出力(カナリアの探査用) */
  consoleLines: string[];
  /** 拡張のページ(設定画面)。chrome.* を呼ぶ検査はここで行う */
  ext: Page;
  url(host: string, port: number, pathAndQuery: string): string;
  setVault(items: FakeItem[], vault?: string, token?: string): Promise<void>;
  send<T = unknown>(message: unknown): Promise<T>;
  /** 設定画面から同期先を保存する(実際の画面の操作) */
  configureSync(token?: string, vault?: string, master?: string): Promise<void>;
  unlock(master?: string): Promise<void>;
  lock(): Promise<void>;
  setOnload(on: boolean): Promise<void>;
  sessionKeys(): Promise<string[]>;
  newPage(): Promise<Page>;
}

export const test = base.extend<object, { env: Env }>({
  env: [
    async ({}, use) => {
      const consoleLines: string[] = [];
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "pwv-e2e-profile-"));
      const pageServers = await startPageServers();
      const breach = new BreachMock();
      await breach.start();
      const wrangler = await startWrangler();

      const context = await chromium.launchPersistentContext(profileDir, {
        executablePath: chromiumPath(),
        headless: false,
        args: [
          "--headless=new",
          `--disable-extensions-except=${dist}`,
          `--load-extension=${dist}`,
          "--lang=en-US",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-search-engine-choice-screen",
        ],
      });
      const hook = (target: { on(ev: "console", cb: (m: { text(): string }) => void): unknown }) =>
        target.on("console", (m) => consoleLines.push(m.text()));
      hook(context as never);
      for (const sw of context.serviceWorkers()) hook(sw as never);
      context.on("serviceworker", (sw) => hook(sw as never));

      let sw = context.serviceWorkers()[0];
      if (!sw) sw = await context.waitForEvent("serviceworker");
      const extId = new URL(sw.url()).host;

      const ext = await context.newPage();
      await ext.goto(`chrome-extension://${extId}/options.html`);

      const env: Env = {
        context,
        extId,
        profileDir,
        breach,
        wrangler,
        consoleLines,
        ext,
        url: (host, port, p) => `http://${host}:${port}${p}`,
        async setVault(items, vault = "main", token = TOKEN_MAIN) {
          await putVault(vault, token, await makeVault(MASTER, items));
        },
        send: (message) => ext.evaluate((m) => chrome.runtime.sendMessage(m), message as never) as Promise<never>,
        async configureSync(token = TOKEN_MAIN, vault = "main", master = MASTER) {
          await ext.goto(`chrome-extension://${extId}/options.html`);
          await ext.fill("#sync-url", SYNC_URL);
          await ext.fill("#vault-name", vault);
          await ext.fill("#token", token);
          await ext.fill("#master", master);
          await ext.click("#save-sync");
          await expect(ext.locator("#sync-msg")).toHaveText(/Saved\./, { timeout: 60_000 });
        },
        async unlock(master = MASTER) {
          const res = await env.send<{ ok: boolean }>({ type: "unlock", master });
          expect(res.ok).toBe(true);
        },
        async lock() {
          await env.send({ type: "lock" });
        },
        async setOnload(on) {
          await ext.evaluate(async (v) => {
            const { settings } = (await chrome.storage.local.get("settings")) as { settings: Record<string, unknown> };
            await chrome.storage.local.set({ settings: { ...settings, onload: v } });
          }, on);
        },
        sessionKeys: () => ext.evaluate(async () => Object.keys(await chrome.storage.session.get(null))),
        newPage: () => context.newPage(),
      };

      try {
        await use(env);
      } finally {
        await context.close();
        // Chrome の一時プロファイル(作業フォルダの外)に本体用の目印が残っていないか
        const hits = await dirContainsBytes(profileDir, [Buffer.from(CANARY)]);
        await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
        await breach.stop();
        for (const s of pageServers) await close(s as http.Server);
        const wranglerOut = wrangler.output();
        await wrangler.stop();
        if (hits.length > 0) throw new Error(`canary found in Chrome profile: ${hits.length} file(s)`);
        if (wranglerOut.includes(CANARY)) throw new Error("canary found in wrangler output");
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],
});

export { expect };
export const appUrl = (p = "/login.html") => `http://app.localhost:${PORT_A}${p}`;
export const appOrigin = `http://app.localhost:${PORT_A}`;
export { PORT_A, PORT_B, MASTER, CANARY };
