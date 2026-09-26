import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ConfigurationEnvironment,
  loadTrustConfiguration,
  type ResolvedTrustConfiguration,
} from "@trust/extension-sdk";

export async function readServerConfiguration(
  environment: ConfigurationEnvironment = process.env,
  defaultStateDirectory?: string,
): Promise<ResolvedTrustConfiguration> {
  return loadTrustConfiguration({
    environment,
    mode: "server",
    resolvePath: resolve,
    defaultRunnerTrialScript: resolve(import.meta.dirname, "../../../trust-runner/dist/skill/trust/scripts/trial.js"),
    readJson: async (file) => JSON.parse(await readFile(file, "utf8")) as unknown,
    ...(defaultStateDirectory ? { defaultStateDirectory } : {}),
  });
}
