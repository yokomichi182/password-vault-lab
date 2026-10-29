// PC での確認(tests/cli/PCの確認.md)用の、ローカルの同期先。
// 使い方: npm run serve:check   (Ctrl+C で止める)
// - ローカルの wrangler dev(.dev.vars は読まない。設定と状態は作業フォルダの外の一時フォルダ)。トークン表は自動処理用(automation)と本体用(main)
// - 本体の保管庫として、架空の項目を1つ入れた保管庫を main に入れる(本体の項目を Claude に頼んでも「該当なし」になる確認用)
// - 架空のトークンとマスターパスワードは一時フォルダの tokens.txt に書く。画面には出さない
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeKdbx } from "../kdbxFixture.ts";
import { SYNC_URL, startWrangler } from "./wrangler.ts";

const rand = () => randomBytes(8).toString("hex");
// 目印はソースに書かず、実行時に組み立てる
const tokenAuto = `${["CANARY", "AUTOM"].join("-")}-${rand()}`;
const tokenMain = `${["CANARY", "7f3e9a1c"].join("-")}-${rand()}`;
const master = `${["CANARY", "7f3e9a1c"].join("-")}-master-${rand()}`;

const wrangler = await startWrangler({ [tokenAuto]: "automation", [tokenMain]: "main" });
const put = await fetch(`${SYNC_URL}/vaults/main`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${tokenMain}`, "If-Match": "0", "X-Device-Name": "serve-check" },
  body: Buffer.from(await makeKdbx({ master }, [{ title: "Main Only Site", username: "main-user", password: `${["CANARY", "7f3e9a1c"].join("-")}-main-only` }])),
});
if (!put.ok) {
  console.error("本体の保管庫の用意に失敗しました");
  await wrangler.stop();
  process.exit(1);
}

const dir = path.join(os.tmpdir(), "pwm-serve-check");
await mkdir(dir, { recursive: true });
await writeFile(
  path.join(dir, "tokens.txt"),
  [`automation-token: ${tokenAuto}`, `main-token: ${tokenMain}`, `master-password: ${master}`, ""].join("\n"),
);

console.log("確認環境が動いています。止めるときは Ctrl+C。");
console.log(`  同期先: ${SYNC_URL}`);
console.log("  保管庫の名前: 自動処理用 automation / 本体用 main");
console.log(`  架空のトークンとマスターパスワード: ${path.join(dir, "tokens.txt")}(ここからコピーして貼る。画面には出さない)`);

const stop = async () => {
  await wrangler.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
await new Promise(() => undefined);
