import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CANARY } from "../test/tokens.ts";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const ignoredDirectoryNames = new Set([".git", "node_modules"]);
const ignoredFiles = new Set([
  path.resolve(projectRoot, "AGENTS.md"),
  path.resolve(projectRoot, "worker", "test", "tokens.ts"),
]);

// テスト入力のソース: Git で追跡しているファイルだけを除外する。追跡していないファイルは同じ場所でも探査する
const testSourceDirectories = ["android/app/src/test", "tests/xcheck"];
const trackedTestSources = execFileSync("git", ["ls-files", "-z", "--", ...testSourceDirectories], {
  cwd: projectRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
for (const file of trackedTestSources) ignoredFiles.add(path.resolve(projectRoot, file));

// 作業フォルダの外にある出力先。テストのソースをコンパイルしたクラスファイルだけ除外する
const buildRoot = path.join(os.homedir(), "pwvault-build");
const ignoredBuildPath = path.join("compileDebugUnitTestKotlin", "classes") + path.sep;
const outsideRoots = [{ root: buildRoot, label: "~/pwvault-build" }];
const xcheckDir = process.env.PWV_XCHECK_DIR && path.resolve(process.env.PWV_XCHECK_DIR);
if (xcheckDir && path.relative(projectRoot, xcheckDir).startsWith("..")) {
  outsideRoots.push({ root: xcheckDir, label: "$PWV_XCHECK_DIR" });
}

const markers = [
  Buffer.from(CANARY, "utf8"),
  Buffer.from(["CANARY", "AUTOM", ""].join("-"), "utf8"),
];
const matches = [];
const symbolicLinks = [];

function display(fullPath) {
  for (const { root, label } of outsideRoots) {
    const rel = path.relative(root, fullPath);
    if (!rel.startsWith("..")) return path.join(label, rel);
  }
  return path.relative(projectRoot, fullPath);
}

function isIgnored(fullPath) {
  if (ignoredFiles.has(fullPath)) return true;
  const rel = path.relative(buildRoot, fullPath);
  return !rel.startsWith("..") && (rel + path.sep).includes(ignoredBuildPath);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      symbolicLinks.push(display(fullPath));
      continue;
    }
    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name)) await walk(fullPath);
      continue;
    }
    if (!entry.isFile() || isIgnored(fullPath)) continue;
    const contents = await readFile(fullPath);
    if (markers.some((marker) => contents.indexOf(marker) !== -1)) {
      matches.push(display(fullPath));
    }
  }
}

await walk(projectRoot);
for (const { root } of outsideRoots) if (existsSync(root)) await walk(root);

if (matches.length > 0 || symbolicLinks.length > 0) {
  if (matches.length > 0) {
    console.error(`Canary scan failed in ${matches.length} file(s):`);
    for (const match of matches.sort()) console.error(match);
  }
  if (symbolicLinks.length > 0) {
    console.error(`Canary scan did not follow ${symbolicLinks.length} symbolic link(s):`);
    for (const link of symbolicLinks.sort()) console.error(link);
  }
  process.exitCode = 1;
} else {
  console.log("Canary scan passed: 0 unexpected files.");
}
