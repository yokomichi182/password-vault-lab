import { defineConfig } from "@playwright/test";

// 拡張を読み込んだ Chromium は一時プロファイルで動かす(利用者の普段の Chrome のプロファイルは使わない)。
// トレース、スクリーンショット、動画は残さない(値を含む画面が作業フォルダに残らないように)。
export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
