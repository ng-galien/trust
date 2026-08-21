import { startRuntime } from "./server.js";
import { normalizeAuthority } from "./check/uri.js";
import { DEFAULT_SESSION_DURATION_MS } from "./plan/runtime.js";
import { DEFAULT_TRIAL_TIMEOUT_MS } from "./trial/service.js";

const host = process.env.TRUST_HOST ?? "127.0.0.1";
const rawPort = process.env.TRUST_PORT ?? "4318";
const port = Number(rawPort);
const databasePath = process.env.TRUST_DATABASE_PATH ?? ".trust/trust.sqlite";
const semanticAuthority = normalizeAuthority(
  process.env.TRUST_SEMANTIC_AUTHORITY ?? "localhost:4318",
);
const operationsDirectory = process.env.TRUST_OPERATIONS_DIRECTORY;
const sessionDurationMs = durationFromEnvironment(
  "TRUST_SESSION_DURATION_MS",
  DEFAULT_SESSION_DURATION_MS,
);
const trialTimeoutMs = durationFromEnvironment(
  "TRUST_TRIAL_TIMEOUT_MS",
  DEFAULT_TRIAL_TIMEOUT_MS,
);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid TRUST_PORT '${rawPort}'.`);
}

const runtime = await startRuntime({
  host,
  port,
  ...(process.env.TRUST_RUNTIME_INSTANCE ? { instance: process.env.TRUST_RUNTIME_INSTANCE } : {}),
  databasePath,
  semanticAuthority,
  ...(operationsDirectory === undefined ? {} : { operationsDirectory }),
  sessionDurationMs,
  trialTimeoutMs,
  ...(process.env.TRUST_DIAGNOSTICS_ENDPOINT ? { diagnosticsEndpoint: process.env.TRUST_DIAGNOSTICS_ENDPOINT } : {}),
  ...(process.env.TRUST_RUNNER_TRIAL_SCRIPT ? { runnerTrialScript: process.env.TRUST_RUNNER_TRIAL_SCRIPT } : {}),
});
process.stdout.write(`TRUST runtime listening on ${runtime.host}:${runtime.port}\n`);

const shutdown = async (): Promise<void> => {
  await runtime.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function durationFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} '${raw}'.`);
  }
  return value;
}
