// 使い方: npm run bridge:manifest -- <出力先フォルダ> [--name com.pwm.bridge] [--home <PWM_HOME>] [--dist <pwm-bridge.mjs のあるフォルダ>]
// Native Messaging のホストの manifest(<name>.json)と、起動に使う pwm-bridge.cmd を作る。
// レジストリへの登録はしない(手順は tests/ai/PCの確認_5.md)。allowed_origins には、拡張の ID(manifest の key から決まる)だけを書く。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = import.meta.dirname;

/** 拡張の公開鍵(manifest の key、base64 の DER)から拡張の ID を求める(SHA-256 の先頭16バイトを a〜p に写す)。 */
export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(keyBase64, "base64");
  const hash = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...hash].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
}

export async function readExtensionId() {
  const manifest = JSON.parse(await readFile(path.join(root, "..", "extension", "static", "manifest.json"), "utf8"));
  if (typeof manifest.key !== "string") throw new Error("extension manifest has no key");
  return extensionIdFromKey(manifest.key);
}

export function cmdText({ node, script, home }) {
  const lines = ["@echo off", "chcp 65001 >nul"];
  if (home) lines.push(`set "PWM_HOME=${home}"`);
  lines.push(`"${node}" "${script}" %*`);
  return lines.join("\r\n") + "\r\n";
}

export function manifestJson({ name, cmdPath, id }) {
  return (
    JSON.stringify(
      {
        name,
        description: "pwm bridge: passes request_fill requests from pwm-mcp to the Tobari extension",
        path: cmdPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${id}/`],
      },
      null,
      2,
    ) + "\n"
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { name: { type: "string" }, home: { type: "string" }, dist: { type: "string" } },
  });
  const outDir = positionals[0];
  if (!outDir) {
    console.error("usage: npm run bridge:manifest -- <output folder> [--name com.pwm.bridge] [--home <PWM_HOME>] [--dist <folder with pwm-bridge.mjs>]");
    process.exit(2);
  }
  const name = values.name ?? "com.pwm.bridge";
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(name)) {
    console.error("the host name must look like com.example.name (lowercase letters, digits, underscores, dots)");
    process.exit(2);
  }
  const dist = path.resolve(values.dist ?? path.join(root, "dist"));
  const script = path.join(dist, "pwm-bridge.mjs");
  if (!existsSync(script)) {
    console.error(`${script} not found. Run "npm run build" first.`);
    process.exit(1);
  }
  const out = path.resolve(outDir);
  await mkdir(out, { recursive: true });
  const cmdPath = path.join(out, "pwm-bridge.cmd");
  const id = await readExtensionId();
  await writeFile(cmdPath, cmdText({ node: process.execPath, script, home: values.home ? path.resolve(values.home) : undefined }), "utf8");
  const manifestPath = path.join(out, `${name}.json`);
  await writeFile(manifestPath, manifestJson({ name, cmdPath, id }), "utf8");
  console.log(`wrote ${manifestPath}`);
  console.log(`wrote ${cmdPath}`);
  console.log(`allowed origin: chrome-extension://${id}/`);
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007f]/.test(manifestPath + cmdPath + script + process.execPath)) {
    console.log("note: a path contains non-ASCII characters. pwm-bridge.cmd switches the code page to UTF-8 (chcp 65001); if Chrome cannot start the host, copy dist to an ASCII-only folder and run this again with --dist.");
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) await main();
