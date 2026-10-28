import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CANARY } from "../test/tokens.ts";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const ignoredDirectoryNames = new Set([".git", "node_modules"]);
const ignoredFiles = new Set([
  path.resolve(projectRoot, "AGENTS.md"),
  path.resolve(projectRoot, "worker", "test", "tokens.ts"),
]);
const markers = [
  Buffer.from(CANARY, "utf8"),
  Buffer.from(["CANARY", "AUTOM", ""].join("-"), "utf8"),
];
const matches = [];
const symbolicLinks = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      symbolicLinks.push(path.relative(projectRoot, fullPath));
      continue;
    }
    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name)) await walk(fullPath);
      continue;
    }
    if (!entry.isFile() || ignoredFiles.has(fullPath)) continue;
    const contents = await readFile(fullPath);
    if (markers.some((marker) => contents.indexOf(marker) !== -1)) {
      matches.push(path.relative(projectRoot, fullPath));
    }
  }
}

await walk(projectRoot);

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
