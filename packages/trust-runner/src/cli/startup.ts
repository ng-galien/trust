import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ConfigurationEnvironment, loadTrustConfiguration } from "@trust/extension-sdk";

export async function runnerStartupConfiguration(environment: ConfigurationEnvironment) {
  const result = await loadTrustConfiguration({
    environment,
    mode: "runner",
    resolvePath: resolve,
    readJson: async (file) => JSON.parse(await readFile(file, "utf8")) as unknown,
  });
  const value = result.configuration;
  return {
    resolved: result,
    environment: {
      ...environment,
      TRUST_LOG_LEVEL: value.logging.level,
      TRUST_RUNNER_LOG_PATH: value.logging.runnerPath,
      ...(value.runner.authFile ? { TRUST_AUTH_FILE: value.runner.authFile } : {}),
    },
  };
}
