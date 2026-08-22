import pino, { type Logger } from "pino";

const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export interface RuntimeLogging {
  readonly logger: Logger;
  flush(): void;
  close(): void;
}

export interface RuntimeLoggingOptions {
  readonly instance?: string;
  readonly level?: string;
  readonly path?: string;
}

/** Host diagnostics only: these records are never Facts and never qualify a Check. */
export function createRuntimeLogging(options: RuntimeLoggingOptions = {}): RuntimeLogging {
  const level = options.level ?? "info";
  if (!LOG_LEVELS.has(level)) {
    throw new TypeError(`Invalid TRUST_LOG_LEVEL '${level}'.`);
  }
  const destination = options.path
    ? pino.destination({ dest: options.path, mkdir: true, sync: true })
    : pino.destination({ dest: 2, sync: true });
  const logger = pino({
    level,
    base: {
      service: "trust-runtime",
      pid: process.pid,
      ...(options.instance ? { instance: options.instance } : {}),
    },
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
  let closed = false;
  return {
    logger,
    flush: () => logger.flush(),
    close: () => {
      if (closed) return;
      logger.flush();
      destination.end();
      closed = true;
    },
  };
}
