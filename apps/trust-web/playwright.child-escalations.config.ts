import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./acceptance",
  testMatch: "child-escalations.acceptance.spec.ts",
  workers: 1,
  reporter: "line",
  timeout: 60000,
  use: { baseURL: "http://127.0.0.1:4177", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: {
    command: "node acceptance/support/child-escalations-server.mjs",
    env: { TRUST_ACCEPTANCE_RESTART_CONTROL: "4398" },
    url: "http://127.0.0.1:4177/health",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
