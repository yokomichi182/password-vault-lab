// PC の Chrome での確認(tests/extension/PCの確認.md)用の、ローカルの確認環境。
// 使い方: npm run serve:check   (Ctrl+C で止める)
// - テストページ: http://app.localhost:<A>/ と、比べる別のオリジン
// - 同期先: ローカルの wrangler dev(.dev.vars は読まない。設定ファイルは作業フォルダの外の一時フォルダ)
// - 漏洩チェックのモック: 拡張を `npm run build:test` で作ったときの送り先 http://localhost:<ポート>
// Android 側で作った extension-vault.kdbx(PWV_EXT_VAULT_DIR)を、保管庫 android に入れる。
// トークンとマスターパスワードはテスト用の架空の値で、画面には出さない(手順書に組み立て方を書く)。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BREACH_PORT, BreachMock, CANARY, PORT_A, PORT_B, SYNC_URL, TOKEN_ANDROID, putVault, sha1Upper, startPageServers, startWrangler } from "./support.ts";

const vaultFile = path.join(process.env.PWV_EXT_VAULT_DIR ?? path.join(os.tmpdir(), "pwv-ext-vault"), "extension-vault.kdbx");
if (!existsSync(vaultFile)) {
  console.error("extension-vault.kdbx がありません。先に Android 側で ExtensionVaultTest を実行してください(手順書の準備を参照)。");
  process.exit(1);
}

const servers = await startPageServers();
const breach = new BreachMock();
// 手順書の「漏洩チェック」用: 確認用ログインのパスワードを、漏洩済み(3回)として返す
breach.add(sha1Upper(`${CANARY}-ext-login`), 3);
await breach.start();
const wrangler = await startWrangler();
await putVault("android", TOKEN_ANDROID, new Uint8Array(await readFile(vaultFile)));

console.log("確認環境が動いています。止めるときは Ctrl+C。");
console.log(`  テストページ(保存したオリジン): http://app.localhost:${PORT_A}/login.html`);
console.log(`  別のオリジン(ポート違い): http://app.localhost:${PORT_B}/login.html`);
console.log(`  別のオリジン(別のホスト): http://app2.localhost:${PORT_A}/login.html`);
console.log(`  同期先: ${SYNC_URL}   保管庫の名前: android`);
console.log(`  漏洩チェックのモック: http://localhost:${BREACH_PORT}(build:test の拡張だけがここへ送る)`);

const stop = async () => {
  await breach.stop();
  await wrangler.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
void servers;
await new Promise(() => undefined);
