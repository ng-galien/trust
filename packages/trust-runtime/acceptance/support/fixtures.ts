import path from "node:path";
import { test as base } from "vitest";
import {
  dropAcceptanceDatabases,
  type PublicRuntimeOptions,
  type PublicRuntimeProcess,
  repositoryRoot,
  startPublicRuntime,
} from "./runtime-process.js";

export { repositoryRoot };

export const catalogOperationsDirectory = path.join(repositoryRoot, "assets/operations");

interface RuntimeFixtures {
  /**
   * The runtime every test of the file shares: the catalog Operations and a "local" environment on this checkout.
   * It starts when the first test asks for it. Tests keep apart through their own Plan and Procedure identifiers.
   */
  readonly runtime: { readonly endpoint: string };
  /**
   * Starts a runtime that belongs to one test and stops with it. For a test whose subject is the start itself, a
   * particular configuration, or a catalog it reads or changes as a whole.
   */
  readonly startRuntime: (prefix?: string, options?: PublicRuntimeOptions) => Promise<PublicRuntimeProcess>;
}

export const test = base.extend<RuntimeFixtures>({
  runtime: [
    // biome-ignore lint/correctness/noEmptyPattern: Vitest reads the fixtures a function asks for from this pattern.
    async ({}, use) => {
      const runtime = await startPublicRuntime("trust-shared-", {
        operationsDirectory: catalogOperationsDirectory,
        environments: { local: { workspaceRoot: repositoryRoot } },
      });
      await use({ endpoint: runtime.endpoint });
      await runtime.close();
      await dropAcceptanceDatabases();
    },
    { scope: "file" },
  ],
  // biome-ignore lint/correctness/noEmptyPattern: Vitest reads the fixtures a function asks for from this pattern.
  startRuntime: async ({}, use) => {
    const started: PublicRuntimeProcess[] = [];
    await use(async (prefix, options) => {
      const runtime = await startPublicRuntime(prefix, options);
      started.push(runtime);
      return runtime;
    });
    await Promise.all(started.map((runtime) => runtime.close()));
    await dropAcceptanceDatabases();
  },
});
