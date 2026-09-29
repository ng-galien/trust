import { defineConfig } from "@playwright/test";

// Registry interface acceptance: a disposable runtime, local Git/HTTP/file registries and the interface built from
// the current sources (acceptance/support/registry-server.mjs). The scenarios share that state in file order.
export default defineConfig({
  testDir: "./acceptance",
  testMatch: ["registry.acceptance.spec.ts"],
  workers: 1,
  fullyParallel: false,
  reporter: "line",
  timeout: 90_000,
  use: { baseURL: "http://127.0.0.1:4183", viewport: { width: 1280, height: 800 }, trace: "retain-on-failure" },
  webServer: {
    command: "node acceptance/support/registry-server.mjs",
    url: "http://127.0.0.1:4183/extensions",
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
