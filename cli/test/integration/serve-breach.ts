// PC での確認(tests/cli/PCの確認_3.6.md)用の、ローカルの漏洩チェックのモックサーバー。実在の Pwned Passwords API には送らない。
// 使い方: npm run serve:breach   (Ctrl+C で止める)。ポートは第1引数か環境変数 PWM_BREACH_PORT(既定 18080)。
// - 127.0.0.1 だけで待ち受け、/range/<5文字> に SUFFIX:COUNT の行(別のハッシュの行と、回数 0 のパディングの行を混ぜて)を返す
// - 「漏洩済みとして扱う」架空の値と、漏洩なしの値、API キーの値を作り、一時フォルダの values.txt に書く。画面には出さない
// - 画面に出すのは、受け取った要求の先頭5文字のパスだけ(パスワードもハッシュの全体も届かない)
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { BreachTable, prefixOf } from "../breachFixture.ts";

const port = Number(process.argv[2] ?? process.env.PWM_BREACH_PORT ?? "18080");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("ポート番号が正しくありません");
  process.exit(1);
}

const dir = path.join(os.tmpdir(), "pwm-serve-breach");
const valuesFile = path.join(dir, "values.txt");

const rand = () => randomBytes(6).toString("hex");
// 目印はソースに書かず、実行時に組み立てる
const marker = ["CANARY", "AUTOM"].join("-");
let pwnedValue = `${marker}-${rand()}-pwned`;
let cleanValue = `${marker}-${rand()}-clean`;
let apikeyValue = `${marker}-${rand()}-apikey`;
// 止めてからもう一度起動しても同じ値で動くよう、前の values.txt があれば、その値を使う
try {
  const old = await readFile(valuesFile, "utf8");
  const pick = (name: string) => new RegExp(`^${name}: (\\S+)`, "m").exec(old)?.[1];
  pwnedValue = pick("pwned-value") ?? pwnedValue;
  cleanValue = pick("clean-value") ?? cleanValue;
  apikeyValue = pick("apikey-value") ?? apikeyValue;
} catch {
  // 無ければ、新しく作った値のまま
}

const table = new BreachTable();
table.addPwned(pwnedValue, 31337);

const server = http.createServer((req, res) => {
  const m = /^\/range\/([0-9A-F]{5})$/.exec(req.url ?? "");
  if (req.method !== "GET" || !m) {
    console.log(`  (対象外の要求) ${req.method ?? ""} ${(req.url ?? "").slice(0, 40)}`);
    res.writeHead(404).end();
    return;
  }
  console.log(`  GET /range/${m[1]}  Add-Padding: ${req.headers["add-padding"] ?? "(なし)"}`);
  res.writeHead(200, { "content-type": "text/plain" }).end(table.body(m[1]!));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

await mkdir(dir, { recursive: true });
await writeFile(
  valuesFile,
  [
    `pwned-value: ${pwnedValue}`,
    `clean-value: ${cleanValue}`,
    `apikey-value: ${apikeyValue}`,
    `(先頭5文字: pwned ${prefixOf(pwnedValue)} / clean ${prefixOf(cleanValue)})`,
    "",
  ].join("\n"),
);

const url = `http://127.0.0.1:${port}`;
console.log("漏洩チェックのモックサーバーが動いています。止めるときは Ctrl+C。実在の API には送りません。");
console.log(`  PWM_BREACH_URL に入れる値: ${url}`);
console.log(`  架空の値(漏洩済みとして扱う1つ、漏洩なし1つ、API キー1つ): ${valuesFile}(ここからコピーして貼る。画面には出さない)`);

const stop = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => undefined);
