import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The tests run from the build, as the runtime they start does; their paths to the repository count from there.
    include: ["dist/acceptance/**/*.acceptance.test.js"],
    // Acceptance tests drive a real runtime process; a start alone takes more than the default five seconds.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
  },
});
