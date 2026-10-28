// エミュレーターの Chrome 用のテストページを配る。使い方: node tests/autofill/serve.mjs [ポート]
// エミュレーターからは http://localhost:<ポート>/ と http://localhost:<ポート>/other/(先に `adb -s emulator-5554 reverse tcp:<ポート> tcp:<ポート>`。Chrome は安全でない http のページでは自動入力を止めるため、10.0.2.2 でなく localhost を使う) で開く。
// Android の webDomain はホストだけなので、ポートとパスを変えても同じ項目に一致する(設計書 §8)。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const port = Number(process.argv[2] ?? 8081);
const page = join(dirname(fileURLToPath(import.meta.url)), 'login.html');

createServer(async (req, res) => {
  if (req.url === '/' || req.url?.startsWith('/other')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(page));
  } else {
    res.writeHead(404).end();
  }
}).listen(port, '0.0.0.0', () => console.log(`serving on ${port}`));
