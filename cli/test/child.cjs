// テスト用の子プロセス。使い方: node child.cjs <動作> [引数...]
const [mode, a, b] = process.argv.slice(2);
const val = (name) => process.env[name] ?? "";

switch (mode) {
  case "check": // 環境変数 a が期待の値 b か(値そのものは出さない)
    process.stdout.write(val(a) === b ? "match" : "mismatch");
    break;
  case "len": // 環境変数 a の長さ(値は出さない)
    process.stdout.write(String(val(a).length));
    break;
  case "echo": // 値を標準出力と標準エラーの両方に出す(伏せ字のテスト)
    process.stdout.write(`out:${val(a)}:end\n`);
    process.stderr.write(`err:${val(a)}:end\n`);
    break;
  case "split": {
    // 値を2つのチャンクに分け、間に待ちを入れて出す(チャンクの切れ目にまたがる値のテスト)
    const v = val(a);
    const h = Math.floor(v.length / 2);
    process.stdout.write(`head:${v.slice(0, h)}`);
    setTimeout(() => process.stdout.write(`${v.slice(h)}:tail\n`), 150);
    break;
  }
  case "big": // 標準出力に a バイトの x を出す
    process.stdout.write("x".repeat(Number(a)));
    break;
  case "exit":
    process.exit(Number(a));
    break;
  case "sleep":
    setInterval(() => undefined, 1000);
    break;
  case "stdin": {
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => process.stdout.write(`stdin:${s.length}`));
    break;
  }
  default:
    process.exit(99);
}
void b;
