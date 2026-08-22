import { createServer, type Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Logger } from "pino";

import {
  startTrustWebSocketLanguageServer,
  type TrustLanguageServerSocket,
} from "@trust/language-server";
import { createRuntimeContainer } from "./runtime.js";
import type { CompiledOperation } from "@trust/operation";

export interface RuntimeServerOptions {
  readonly host: string;
  readonly port: number;
  readonly instance?: string;
  readonly databasePath?: string;
  readonly semanticAuthority?: string;
  readonly operations?: readonly CompiledOperation[];
  readonly operationsDirectory?: string;
  readonly sessionDurationMs?: number;
  readonly diagnosticsEndpoint?: string;
  readonly runnerTrialScript?: string;
  readonly trialTimeoutMs?: number;
  readonly logger?: Logger;
}

export interface RunningRuntime {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const listen = (server: Server, host: string, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // A development reload or process shutdown must not wait for an idle keep-alive client.
    server.closeAllConnections();
  });

const languageServerSocket = (webSocket: WebSocket): TrustLanguageServerSocket => ({
  send: (content) => webSocket.send(content),
  onMessage: (callback) => webSocket.on("message", (data: RawData) => callback(data.toString())),
  onError: (callback) => webSocket.on("error", callback),
  onClose: (callback) => webSocket.on("close", callback),
  dispose: () => webSocket.close(),
});

export const startRuntime = async ({
  host,
  port,
  instance,
  databasePath,
  semanticAuthority,
  operations,
  operationsDirectory,
  sessionDurationMs,
  diagnosticsEndpoint,
  runnerTrialScript,
  trialTimeoutMs,
  logger,
}: RuntimeServerOptions): Promise<RunningRuntime> => {
  const server = createServer();
  const recentHttpFailures = new Map<string, number>();
  await listen(server, host, port);

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("TRUST runtime did not bind a TCP address.");
  }

  let container: Awaited<ReturnType<typeof createRuntimeContainer>>;
  try {
    container = await createRuntimeContainer({
      ...(databasePath ? { databasePath } : {}),
      ...(semanticAuthority ? { semanticAuthority } : {}),
      ...(operations ? { operations } : {}),
      ...(operationsDirectory ? { operationsDirectory } : {}),
      ...(sessionDurationMs === undefined ? {} : { sessionDurationMs }),
      diagnosticsEndpoint: diagnosticsEndpoint ?? `http://${host}:${address.port}/otlp/diagnostics`,
      ...(runnerTrialScript ? { runnerTrialScript } : {}),
      ...(trialTimeoutMs === undefined ? {} : { trialTimeoutMs }),
    });
  } catch (error) {
    await close(server);
    throw error;
  }
  const httpApp = container.resolve("httpApp");
  server.on("request", (request, response) => {
    const startedAt = Date.now();
    const requestPath = httpRequestPath(request.url);
    const requestLogger = logger?.child({
      component: "http",
      method: request.method,
      path: requestPath,
    });
    response.once("finish", () => {
      const bindings = {
        event: "http.request.completed",
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
      };
      if (requestPath === "/health") {
        requestLogger?.debug(bindings, "HTTP request completed");
      } else if (response.statusCode >= 400) {
        const key = `${request.method ?? ""} ${requestPath} ${response.statusCode}`;
        if (firstHttpFailureWithin(recentHttpFailures, key, Date.now())) {
          requestLogger?.warn(bindings, "HTTP request failed");
        } else {
          requestLogger?.debug(bindings, "Repeated HTTP request failure");
        }
      } else {
        requestLogger?.info(bindings, "HTTP request completed");
      }
    });
    response.once("close", () => {
      if (!response.writableFinished) {
        requestLogger?.warn({
          event: "http.request.interrupted",
          durationMs: Date.now() - startedAt,
        }, "HTTP connection closed before the response completed");
      }
    });
    if (instance) response.setHeader("x-trust-runtime-instance", instance);
    try {
      httpApp(request, response);
    } catch (error) {
      requestLogger?.error({ err: error, event: "http.request.failed" }, "HTTP request failed");
      throw error;
    }
  });
  const languageServer = new WebSocketServer({ server, path: "/lsp" });
  languageServer.on("connection", (webSocket) => {
    logger?.info({ event: "lsp.connection.opened", component: "lsp" }, "LSP connection opened");
    webSocket.on("error", (error) => {
      logger?.error({ err: error, event: "lsp.connection.failed", component: "lsp" }, "LSP connection failed");
    });
    webSocket.on("close", (code) => {
      logger?.info({ event: "lsp.connection.closed", component: "lsp", code }, "LSP connection closed");
    });
    startTrustWebSocketLanguageServer(languageServerSocket(webSocket), {
      operations: () => container.resolve("operationCatalog").list(),
    });
  });

  return {
    host,
    port: address.port,
    close: async () => {
      for (const client of languageServer.clients) client.close();
      await new Promise<void>((resolve, reject) => languageServer.close((error) => error ? reject(error) : resolve()));
      await close(server);
      await container.dispose();
    },
  };
};

const HTTP_FAILURE_LOG_INTERVAL_MS = 60_000;
const MAX_RECENT_HTTP_FAILURES = 100;

function firstHttpFailureWithin(failures: Map<string, number>, key: string, now: number): boolean {
  const previous = failures.get(key);
  if (previous !== undefined && now - previous < HTTP_FAILURE_LOG_INTERVAL_MS) return false;
  if (!failures.has(key) && failures.size >= MAX_RECENT_HTTP_FAILURES) {
    const oldest = failures.keys().next().value as string | undefined;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.delete(key);
  failures.set(key, now);
  return true;
}

function httpRequestPath(value: string | undefined): string {
  if (value === undefined) return "";
  try {
    return new URL(value, "http://trust.invalid").pathname;
  } catch {
    return value.split("?", 1)[0] ?? "";
  }
}
