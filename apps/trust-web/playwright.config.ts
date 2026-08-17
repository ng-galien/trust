import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./acceptance",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  projects: [
    { name: "acceptance", testMatch: /\.acceptance\.spec\.ts$/ },
    // Documentation screenshots — `npm run docs:capture`; never part of the acceptance run.
    { name: "docs-capture", testMatch: /\.capture\.ts$/, timeout: 60_000 },
  ],
  use: {
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node acceptance/support/server.mjs",
    url: "http://127.0.0.1:4174/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
