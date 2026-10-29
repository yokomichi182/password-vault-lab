// 使い方: node build.mjs
// 出力: dist/pwm.mjs(CLI)と dist/pwm-mcp.mjs(MCP サーバー)。Node 向けの ESM に束ねる。
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

for (const [name, entry] of [
  ["pwm", "src/pwm.ts"],
  ["pwm-mcp", "src/pwm-mcp.ts"],
]) {
  if (!existsSync(path.join(root, entry))) continue;
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(dist, `${name}.mjs`),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    alias,
    banner: { js: banner },
    logLevel: "warning",
  });
}
console.log("built dist/pwm.mjs, dist/pwm-mcp.mjs");
