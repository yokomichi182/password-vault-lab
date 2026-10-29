import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 拡張の共有部品と cli が同じ kdbxweb・hash-wasm を読むように1つに固める(build.mjs と同じ)
export default defineConfig({
  resolve: {
    alias: {
      kdbxweb: fileURLToPath(import.meta.resolve("kdbxweb")),
      "hash-wasm": fileURLToPath(import.meta.resolve("hash-wasm")),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
