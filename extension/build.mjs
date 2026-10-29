// 使い方: node build.mjs [--test]
// 通常のビルドは漏洩チェックの送り先を https://api.pwnedpasswords.com に固定する。
// Native Messaging のホストの名前は、通常のビルドは com.pwm.bridge、--test は com.pwm.bridge.test。
// --test のときだけ、送り先を http://localhost:<ポート> に差し替え、テスト用に localhost への通信を許す。
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const dist = path.join(root, "dist");
const isTest = process.argv.includes("--test");
const breachPort = process.env.PWV_BREACH_PORT ?? "18999";

const breachBase = isTest ? `http://localhost:${breachPort}` : "https://api.pwnedpasswords.com";

const entries = {
  background: "src/background/index.ts",
  content: "src/content/index.ts",
  popup: "src/popup/popup.ts",
  options: "src/options/options.ts",
  offscreen: "src/offscreen/offscreen.ts",
  approve: "src/approve/approve.ts",
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const [name, entry] of Object.entries(entries)) {
  if (!existsSync(path.join(root, entry))) continue;
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(dist, `${name}.js`),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    alias: { crypto: path.join(root, "src/shims/empty.ts") },
    define: {
      __TEST__: JSON.stringify(isTest),
      __BREACH_BASE__: JSON.stringify(breachBase),
      __BRIDGE_HOST__: JSON.stringify(isTest ? "com.pwm.bridge.test" : "com.pwm.bridge"),
    },
    logLevel: "warning",
  });
}

// 静的ファイル(HTML、CSS、ロケール)
for (const name of ["popup.html", "options.html", "offscreen.html", "approve.html", "style.css", "_locales"]) {
  const from = path.join(root, "static", name);
  if (existsSync(from)) await cp(from, path.join(dist, name), { recursive: true });
}

const manifest = JSON.parse(await readFile(path.join(root, "static", "manifest.json"), "utf8"));
if (isTest) {
  // テスト用: 同期先とモックの漏洩チェックの localhost への通信を、権限の確認なしで許す。通常のビルドには入らない。
  manifest.host_permissions = [...manifest.host_permissions, "http://localhost/*"];
}
await writeFile(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`built dist/ (${isTest ? "test" : "release"})`);
