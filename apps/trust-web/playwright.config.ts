import { defineConfig } from "@playwright/test";

const webPort = process.env.TRUST_WEB_ACCEPTANCE_WEB_PORT ?? "4174";

// A continuous-integration runner renders a page more slowly than a workstation: the assertions wait longer there.
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./acceptance",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: ci ? 90_000 : 30_000,
  expect: { timeout: ci ? 30_000 : 5_000 },
  retries: ci ? 1 : 0,
  projects: [
    {
      name: "acceptance",
      testMatch: /\.acceptance\.spec\.ts$/,
      testIgnore: [
        "child-escalations.acceptance.spec.ts",
        // Runs against its own runtime and local registries (playwright.registry.config.ts).
        "registry.acceptance.spec.ts",
        // The Corpus specs run against their own runtime with the Corpus extension (playwright.corpus.config.ts).
        /corpus-.*\.acceptance\.spec\.ts$/,
      ],
    },
    // Documentation screenshots — `npm run docs:capture`; never part of the acceptance run.
    { name: "docs-capture", testMatch: /\.capture\.ts$/, timeout: 60_000 },
  ],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node acceptance/support/server.mjs",
    url: `http://127.0.0.1:${webPort}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
