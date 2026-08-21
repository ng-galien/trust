import { createServer, type Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

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
}: RuntimeServerOptions): Promise<RunningRuntime> => {
  const server = createServer();
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
    if (instance) response.setHeader("x-trust-runtime-instance", instance);
    httpApp(request, response);
  });
  const languageServer = new WebSocketServer({ server, path: "/lsp" });
  languageServer.on("connection", (webSocket) => {
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
