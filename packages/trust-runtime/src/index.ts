import { startRuntime } from "./server.js";
import { normalizeAuthority } from "./check/uri.js";
import { createRuntimeLogging } from "./logging.js";
import { DEFAULT_SESSION_DURATION_MS } from "./plan/runtime.js";
import { DEFAULT_TRIAL_TIMEOUT_MS } from "./trial/service.js";

const instance = process.env.TRUST_RUNTIME_INSTANCE;
const logging = createRuntimeLogging({
  ...(instance ? { instance } : {}),
  ...(process.env.TRUST_LOG_LEVEL ? { level: process.env.TRUST_LOG_LEVEL } : {}),
  ...(process.env.TRUST_RUNTIME_LOG_PATH ? { path: process.env.TRUST_RUNTIME_LOG_PATH } : {}),
});
const logger = logging.logger;

process.on("uncaughtExceptionMonitor", (error, origin) => {
  logger.fatal({ err: error, event: "process.uncaught_exception", origin }, "Uncaught runtime exception");
  logging.flush();
});
process.on("warning", (warning) => {
  logger.warn({ err: warning, event: "process.warning" }, "Runtime process warning");
});

let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
try {
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

  logger.info({
    event: "runtime.starting",
    component: "process",
    host,
    port,
    databasePath,
  }, "TRUST runtime starting");
  runtime = await startRuntime({
    host,
    port,
    ...(instance ? { instance } : {}),
    databasePath,
    semanticAuthority,
    ...(operationsDirectory === undefined ? {} : { operationsDirectory }),
    sessionDurationMs,
    trialTimeoutMs,
    ...(process.env.TRUST_DIAGNOSTICS_ENDPOINT ? { diagnosticsEndpoint: process.env.TRUST_DIAGNOSTICS_ENDPOINT } : {}),
    ...(process.env.TRUST_RUNNER_TRIAL_SCRIPT ? { runnerTrialScript: process.env.TRUST_RUNNER_TRIAL_SCRIPT } : {}),
    logger,
  });
  logger.info({
    event: "runtime.started",
    component: "process",
    host: runtime.host,
    port: runtime.port,
  }, "TRUST runtime started");
  process.stdout.write(`TRUST runtime listening on ${runtime.host}:${runtime.port}\n`);
} catch (error) {
  logger.fatal({ err: error, event: "runtime.start_failed", component: "process" }, "TRUST runtime failed to start");
  logging.close();
  process.exitCode = 1;
}

let shutdownStarted = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info({ event: "runtime.shutdown_started", component: "process", signal }, "TRUST runtime shutting down");
  try {
    await runtime?.close();
    logger.info({ event: "runtime.shutdown_completed", component: "process", signal }, "TRUST runtime stopped");
    process.exitCode = 0;
  } catch (error) {
    logger.fatal({ err: error, event: "runtime.shutdown_failed", component: "process", signal }, "TRUST runtime shutdown failed");
    process.exitCode = 1;
  } finally {
    logging.close();
  }
};

if (runtime) {
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

function durationFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} '${raw}'.`);
  }
  return value;
}
