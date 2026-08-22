import path from "node:path";

import pino, { type Logger } from "pino";

import { clip, type DiagnosticEvent, type DiagnosticsSink } from "./events.js";

const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export interface RunnerLogging {
  readonly logger: Logger;
  readonly diagnostics: DiagnosticsSink;
  close(): void;
}

export function createRunnerLogging(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RunnerLogging {
  const level = environment.TRUST_LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.has(level)) throw new TypeError(`Invalid TRUST_LOG_LEVEL '${level}'.`);
  const logPath = environment.TRUST_RUNNER_LOG_PATH
    ?? path.resolve(environment.TRUST_SERVER_STATE_DIRECTORY ?? ".trust/server", "runner.log");
  const destination = pino.destination({ dest: logPath, mkdir: true, sync: true });
  const logger = pino({
    level,
    base: { service: "trust-runner", pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err },
    redact: {
      paths: [
        "authorization",
        "cookie",
        "password",
        "token",
        "headers.authorization",
        "headers.cookie",
      ],
      remove: true,
    },
  }, destination);
  const diagnostics: DiagnosticsSink = {
    emit: (event) => emit(logger, event),
    async flush() {
      logger.flush();
    },
  };
  let closed = false;
  return {
    logger,
    diagnostics,
    close: () => {
      if (closed) return;
      logger.flush();
      destination.end();
      closed = true;
    },
  };
}

function emit(logger: Logger, event: DiagnosticEvent): void {
  if (event.type === "step.log") {
    logger.debug({
      event: `runner.${event.type}`,
      step: event.step,
      stream: event.stream,
      bytes: Buffer.byteLength(event.text),
    }, "Runner step output observed");
    return;
  }
  if (event.type === "runner.log") {
    logger[event.level]({ event: "runner.message" }, clip(event.text, 8_192));
    return;
  }
  if (event.type === "operation.start") {
    logger.info({
      event: "runner.operation.start",
      operation: event.operation,
      version: event.version,
      stepCount: event.stepCount,
    }, "Runner operation started");
    return;
  }
  if (event.type === "step.start") {
    logger.info({
      event: "runner.step.start",
      step: event.step,
      index: event.index,
      kind: event.kind,
      summary: event.summary,
      detail: event.detail,
    }, "Runner step started");
    return;
  }
  if (event.type === "step.end") {
    const bindings = {
      event: "runner.step.end",
      step: event.step,
      ok: event.ok,
      durationMs: event.durationMs,
      outcome: Object.fromEntries(
        Object.entries(event.outcome).filter(([name]) => !name.endsWith("Preview")),
      ),
      ...(event.error ? { error: event.error } : {}),
    };
    if (event.ok) logger.info(bindings, "Runner step completed");
    else logger.error(bindings, "Runner step failed");
    return;
  }
  const bindings = {
    event: "runner.operation.end",
    ok: event.ok,
    durationMs: event.durationMs,
    ...(event.error ? { error: event.error } : {}),
  };
  if (event.ok) logger.info(bindings, "Runner operation completed");
  else logger.error(bindings, "Runner operation failed");
}
