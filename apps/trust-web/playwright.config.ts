import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./acceptance",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node acceptance/support/server.mjs",
    url: "http://127.0.0.1:4174/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
