import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./acceptance",
  testMatch: ["extensions.acceptance.spec.ts", "extension-sort.acceptance.spec.ts", "svg-rendering.acceptance.spec.ts"],
  workers: 1,
  reporter: "line",
  timeout: 60000,
  use: { baseURL: "http://127.0.0.1:4177", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: {
    command: "node acceptance/support/extensions-server.mjs",
    url: "http://127.0.0.1:4177/health",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
