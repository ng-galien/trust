import { defineConfig } from "@playwright/test";
import { CORPUS_WEB_PORT } from "./acceptance/support/corpus-fixture.js";

export default defineConfig({
  testDir: "./acceptance",
  testMatch: ["corpus-document.acceptance.spec.ts", "corpus-facet.acceptance.spec.ts"],
  workers: 1,
  reporter: "line",
  timeout: 90000,
  use: {
    baseURL: `http://127.0.0.1:${CORPUS_WEB_PORT}`,
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node acceptance/support/corpus-server.mjs",
    url: `http://127.0.0.1:${CORPUS_WEB_PORT}/health`,
    reuseExistingServer: false,
    timeout: 300000,
  },
});
