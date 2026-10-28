// vitest の設定（Node 側）で TOKENS を組み立てる。.dev.vars は使わない。
import { createHash } from "node:crypto";
import { TOKEN_AUTO, TOKEN_MAIN } from "./tokens.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const TEST_TOKENS_JSON = JSON.stringify({
  [sha(TOKEN_MAIN)]: "main",
  [sha(TOKEN_AUTO)]: "automation",
});
