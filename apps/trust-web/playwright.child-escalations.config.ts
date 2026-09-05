import { defineConfig } from "@playwright/test";
import federation from "./playwright.extensions.config.js";

export default defineConfig({
  ...federation,
  testMatch: "child-escalations.acceptance.spec.ts",
  webServer: { ...federation.webServer, env: { TRUST_ACCEPTANCE_RESTART_CONTROL: "4398" } },
});
