// pwm-bridge: Chrome が起動する Native Messaging のホスト(標準入出力)。実装指示_フェーズ5 の 3-6。
// 標準出力は Native Messaging の通信だけに使う。ログは出さない(標準エラーにも、値・項目名は出さない)。
// 見張る場所は <PWM_HOME>\bridge\。依頼のファイルを拾って拡張に渡し、拡張の結果を応答のファイルに書く。
import { watch, mkdirSync, realpathSync, type FSWatcher } from "node:fs";
import { pathToFileURL } from "node:url";
import { FrameReader, encodeFrame } from "./bridge/frames.ts";
import { BridgeHost } from "./bridge/host.ts";
import { bridgeDir, bridgeHome } from "./bridge/files.ts";

const POLL_MS = 2000;

/** Chrome が渡す呼び出し元(chrome-extension://<ID>/)。拡張の ID はホストの manifest の allowed_origins で Chrome が確かめる。ここでは形だけ見る。 */
const ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}\/$/;

function main(): void {
  const origin = process.argv.slice(2).find((a) => a.startsWith("chrome-extension://"));
  if (origin !== undefined && !ORIGIN_RE.test(origin)) process.exit(1);

  const dir = bridgeDir(bridgeHome(process.env as Record<string, string | undefined>));
  mkdirSync(dir, { recursive: true });

  const host = new BridgeHost({
    dir,
    send: (msg) => void process.stdout.write(encodeFrame(msg)),
    now: () => Date.now(),
  });

  const reader = new FrameReader(
    (msg) => void host.onExtensionMessage(msg).catch(() => undefined),
    () => process.exit(1),
  );
  process.stdin.on("data", (d: Buffer) => reader.push(d));
  process.stdin.on("end", () => process.exit(0)); // 拡張がポートを閉じたら終わる
  process.stdin.on("error", () => process.exit(0));
  process.stdout.on("error", () => process.exit(0));

  const scan = (): void => void host.scan().catch(() => undefined);
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, () => scan());
    watcher.on("error", () => undefined);
  } catch {
    // 見張れなくても、2秒ごとの見直しで拾う
  }
  setInterval(scan, POLL_MS).unref?.();
  host.hello();
  scan();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) main();
