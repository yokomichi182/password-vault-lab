import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __PWM_TEST_DIALOG_ENV__: '""' },
  resolve: {
    alias: {
      kdbxweb: fileURLToPath(import.meta.resolve("kdbxweb")),
      "hash-wasm": fileURLToPath(import.meta.resolve("hash-wasm")),
    },
  },
  test: {
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
