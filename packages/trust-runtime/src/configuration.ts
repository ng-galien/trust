import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ConfigurationEnvironment,
  loadTrustConfiguration,
  type ResolvedTrustConfiguration,
} from "@trust/extension-sdk";
import { matchStorageConfiguration } from "@trust/extension-sdk/match";

export async function runtimeConfiguration(environment: ConfigurationEnvironment): Promise<ResolvedTrustConfiguration> {
  const result = await loadTrustConfiguration({
    environment,
    mode: "runtime",
    resolvePath: resolve,
    defaultRunnerTrialScript: resolve(import.meta.dirname, "../../../trust-runner/dist/skill/trust/scripts/trial.js"),
    readJson: async (file) => JSON.parse(await readFile(file, "utf8")) as unknown,
  });
  if (
    matchStorageConfiguration(result.configuration.storage, { pglite: () => true, postgresql: () => false }) &&
    result.sources["storage.directory"] === "default" &&
    existsSync(resolve(".trust/trust.sqlite"))
  )
    throw new Error("Retained SQLite detected; import explicitly and select a storage target");
  return result;
}
