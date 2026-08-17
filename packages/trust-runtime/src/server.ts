import { createServer, type Server } from "node:http";
import { createRuntimeContainer } from "./runtime.js";
import type { CompiledOperation } from "@trust/operation";

export interface RuntimeServerOptions {
  readonly host: string;
  readonly port: number;
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

export const startRuntime = async ({
  host,
  port,
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
  server.on("request", container.resolve("httpApp"));

  return {
    host,
    port: address.port,
    close: async () => {
      await close(server);
      await container.dispose();
    },
  };
};
