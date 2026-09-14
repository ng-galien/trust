import { defineConfig } from "@playwright/test";

// Read-only acceptance against an explicitly running local project. No server or seed lifecycle.
export default defineConfig({
  testDir: "./acceptance",
  testMatch: /delegation\.live\.spec\.ts$/,
  workers: 1,
  reporter: "line",
  outputDir: "/tmp/trust-delegation-live-results",
  use: { baseURL: "http://127.0.0.1:4176", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
