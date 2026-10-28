import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
// テスト用のトークンは架空の値。TOKENS には SHA-256 の16進だけを入れる。
import { TEST_TOKENS_JSON } from "./test/fixtures.node.ts";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TOKENS: TEST_TOKENS_JSON, TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
