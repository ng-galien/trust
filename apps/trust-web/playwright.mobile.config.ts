import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./acceptance",
  testMatch: "mobile-companion.acceptance.spec.ts",
  workers: 1,
  reporter: "line",
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:4179",
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node acceptance/support/mobile-server.mjs",
    url: "http://127.0.0.1:4179/health",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
