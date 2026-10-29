import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 拡張の共有部品と cli が同じ kdbxweb・hash-wasm を読むように1つに固める(build.mjs と同じ)
export default defineConfig({
  define: { __PWM_TEST_DIALOG_ENV__: '""' }, // 単体テストは差し替えの口を使わない(依存を引数で渡す)
  resolve: {
    alias: {
      kdbxweb: fileURLToPath(import.meta.resolve("kdbxweb")),
      "hash-wasm": fileURLToPath(import.meta.resolve("hash-wasm")),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    exclude: ["test/integration/**"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
