import { publicTrustConfiguration } from "@trust/extension-sdk";
import { runtimeConfiguration } from "./configuration.js";
import { createRuntimeLogging } from "./logging.js";
import { startRuntime } from "./server.js";

const resolved = await runtimeConfiguration(process.env).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid configuration"}\n`);
  process.exit(1);
});
if (process.argv[2] === "--print-config") {
  process.stdout.write(`${JSON.stringify(publicTrustConfiguration(resolved), null, 2)}\n`);
  process.exit(0);
}
const configuration = resolved.configuration;
const instance = process.env.TRUST_RUNTIME_INSTANCE;
const logging = createRuntimeLogging({
  ...(instance ? { instance } : {}),
  level: configuration.logging.level,
  ...(configuration.logging.runtimePath ? { path: configuration.logging.runtimePath } : {}),
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
  const { host, port, semanticAuthority, operationsDirectory, sessionDurationMs, trialTimeoutMs } =
    configuration.server;
  const { storage, authentication } = configuration;

  logger.info(
    {
      event: "runtime.starting",
      component: "process",
      host,
      port,
      storage: storage.kind,
    },
    "TRUST runtime starting",
  );
  runtime = await startRuntime({
    ...(configuration.server.extensionsFile ? { extensionsFile: configuration.server.extensionsFile } : {}),
    extensionTimeoutMs: configuration.server.extensionTimeoutMs,
    host,
    port,
    accessConfiguration: authentication.access,
    ...(authentication.browser ? { browserAuthentication: authentication.browser } : {}),
    ...(authentication.resourceUrl ? { accessResourceUrl: authentication.resourceUrl } : {}),
    ...(instance ? { instance } : {}),
    storage,
    semanticAuthority,
    ...(operationsDirectory === undefined ? {} : { operationsDirectory }),
    sessionDurationMs,
    trialTimeoutMs,
    ...(configuration.server.diagnosticsEndpoint
      ? { diagnosticsEndpoint: configuration.server.diagnosticsEndpoint }
      : {}),
    ...(configuration.server.runnerTrialScript ? { runnerTrialScript: configuration.server.runnerTrialScript } : {}),
    logger,
  });
  logger.info(
    {
      event: "runtime.started",
      component: "process",
      host: runtime.host,
      port: runtime.port,
    },
    "TRUST runtime started",
  );
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
    logger.fatal(
      { err: error, event: "runtime.shutdown_failed", component: "process", signal },
      "TRUST runtime shutdown failed",
    );
    process.exitCode = 1;
  } finally {
    logging.close();
  }
};

if (runtime) {
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
