import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.acceptance.spec.ts",
  use: {
    baseURL: process.env.DRAGON_HEIST_WEB_URL ?? "http://127.0.0.1:4187",
    viewport: { width: 1440, height: 1100 },
  },
  outputDir: "../test-results",
  reporter: "list",
  workers: 1,
});
