// 使い方: node build.mjs
// 出力: dist/pwm.mjs(CLI)、dist/pwm-mcp.mjs(MCP サーバー)、dist/pwm-bridge.mjs(Native Messaging のホスト)。Node 向けの ESM に束ねる。
// dist/test/ はテスト用のビルド(同じ3つ)。
// dist/serve-check.mjs は PC での確認用の同期先(npm run serve:check)、dist/serve-breach.mjs は漏洩チェックのモック(npm run serve:breach)。
// kdbxweb と hash-wasm は cli/node_modules の1つに固める(拡張の共有部品が別のコピーを読むと、Argon2 の設定が効かなくなるため)。
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = import.meta.dirname;
const dist = path.join(root, "dist");

const alias = {
  kdbxweb: fileURLToPath(import.meta.resolve("kdbxweb")),
  "hash-wasm": fileURLToPath(import.meta.resolve("hash-wasm")),
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const banner = [
  "#!/usr/bin/env node",
  'import { createRequire as __pwmCreateRequire } from "node:module";',
  "const require = __pwmCreateRequire(import.meta.url);",
].join("\n");

// 通常のビルド(dist/)と、テスト用のビルド(dist/test/)を作る。
// テスト用のビルドだけ、承認ダイアログを台本のファイルに差し替える口(PWM_TEST_DIALOG_FILE)などが入る。
// 通常のビルドにはこの口が入らない(cli/test/ のテストで束の中を確かめる)。
const targets = [
  ["pwm", "src/pwm.ts"],
  ["pwm-mcp", "src/pwm-mcp.ts"],
  ["pwm-bridge", "src/pwm-bridge.ts"],
  ["serve-check", "test/integration/serve-check.ts"],
  ["serve-breach", "test/integration/serve-breach.ts"],
];
const testTargets = new Set(["pwm", "pwm-mcp", "pwm-bridge"]);

for (const variant of ["release", "test"]) {
  const isTest = variant === "test";
  const outDir = isTest ? path.join(dist, "test") : dist;
  if (isTest) await mkdir(outDir, { recursive: true });
  for (const [name, entry] of targets) {
    if (isTest && !testTargets.has(name)) continue;
    if (!existsSync(path.join(root, entry))) continue;
    await build({
      entryPoints: [path.join(root, entry)],
      outfile: path.join(outDir, `${name}.mjs`),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      sourcemap: false,
      minify: false,
      legalComments: "none",
      alias,
      define: { __PWM_TEST_DIALOG_ENV__: JSON.stringify(isTest ? "PWM_TEST_DIALOG_FILE" : "") },
      banner: { js: banner },
      logLevel: "warning",
    });
  }
}
console.log("built dist/");
