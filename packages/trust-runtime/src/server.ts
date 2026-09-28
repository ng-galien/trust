import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  AccessConfiguration,
  AccessContext,
  BrowserAuthenticationConfiguration,
  DevelopmentAuthenticationConfiguration,
  StorageConfiguration,
} from "@trust/extension-sdk";
import { configurationAuthority } from "@trust/extension-sdk";
import { matchAccessContext } from "@trust/extension-sdk/match";
import { startTrustWebSocketLanguageServer, type TrustLanguageServerSocket } from "@trust/language-server";
import type { CompiledOperation } from "@trust/operation";
import type { Logger } from "pino";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { allowedBrowserOrigin } from "./access/browser-origin.js";
import type { AccessSecretResolver } from "./access/configuration.js";
import type { AccessService } from "./access/service.js";
import { createRuntimeContainer } from "./runtime.js";

export interface RuntimeServerOptions {
  readonly accessConfiguration?: AccessConfiguration;
  readonly accessSecretResolver?: AccessSecretResolver;
  readonly browserAuthentication?: BrowserAuthenticationConfiguration;
  readonly developmentAuthentication?: DevelopmentAuthenticationConfiguration;
  readonly accessResourceUrl?: string;
  readonly extensionsFile?: string;
  readonly extensionTimeoutMs?: number;
  readonly packagesDirectory?: string;
  readonly credentialKeyFile?: string;
  readonly host: string;
  readonly port: number;
  readonly instance?: string;
  readonly storage?: StorageConfiguration;
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

const languageServerSocket = (
  webSocket: WebSocket,
  authorizeMessage: () => Promise<void>,
): TrustLanguageServerSocket => ({
  send: (content) => webSocket.send(content),
  onMessage: (callback) => {
    let pending = Promise.resolve();
    webSocket.on("message", (data: RawData) => {
      pending = pending
        .then(async () => {
          await authorizeMessage();
          callback(data.toString());
        })
        .catch(() => {
          webSocket.close(1008, "Access denied");
        });
    });
  },
  onError: (callback) => webSocket.on("error", callback),
  onClose: (callback) => webSocket.on("close", callback),
  dispose: () => webSocket.close(),
});

export const startRuntime = async ({
  accessConfiguration,
  accessSecretResolver,
  browserAuthentication,
  developmentAuthentication,
  accessResourceUrl,
  extensionsFile,
  extensionTimeoutMs,
  packagesDirectory,
  credentialKeyFile,
  host,
  port,
  instance,
  storage,
  semanticAuthority,
  operations,
  operationsDirectory,
  sessionDurationMs,
  diagnosticsEndpoint,
  runnerTrialScript,
  trialTimeoutMs,
  logger,
}: RuntimeServerOptions): Promise<RunningRuntime> => {
  if (developmentAuthentication && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new TypeError("Development authentication requires a loopback runtime listener");
  const server = createServer();
  // Storage initialization is asynchronous. Requests arriving on the bound port
  // before the application is ready must receive a response, not hang forever.
  const starting = (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
    response.end(JSON.stringify({ status: "starting", service: "trust-runtime" }));
  };
  server.on("request", starting);
  const recentHttpFailures = new Map<string, number>();
  await listen(server, host, port);

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("TRUST runtime did not bind a TCP address.");
  }

  let container: Awaited<ReturnType<typeof createRuntimeContainer>>;
  try {
    if (
      accessConfiguration &&
      accessConfiguration.mode !== "local" &&
      diagnosticsEndpoint &&
      new URL(diagnosticsEndpoint).origin !== `http://${configurationAuthority(host, address.port)}`
    ) {
      throw new TypeError("Shared Trial diagnostics must use this runtime's origin");
    }
    container = await createRuntimeContainer({
      ...(accessConfiguration ? { accessConfiguration } : {}),
      ...(accessSecretResolver ? { accessSecretResolver } : {}),
      ...(browserAuthentication ? { browserAuthentication } : {}),
      ...(developmentAuthentication ? { developmentAuthentication } : {}),
      ...(accessResourceUrl ? { accessResourceUrl } : {}),
      ...(extensionsFile === undefined ? {} : { extensionsFile }),
      ...(extensionTimeoutMs === undefined ? {} : { extensionTimeoutMs }),
      ...(packagesDirectory === undefined ? {} : { packagesDirectory }),
      ...(credentialKeyFile === undefined ? {} : { credentialKeyFile }),
      ...(storage ? { storage } : {}),
      ...(semanticAuthority ? { semanticAuthority } : {}),
      ...(operations ? { operations } : {}),
      ...(operationsDirectory ? { operationsDirectory } : {}),
      ...(sessionDurationMs === undefined ? {} : { sessionDurationMs }),
      diagnosticsEndpoint:
        diagnosticsEndpoint ?? `http://${configurationAuthority(host, address.port)}/otlp/diagnostics`,
      ...(runnerTrialScript ? { runnerTrialScript } : {}),
      ...(trialTimeoutMs === undefined ? {} : { trialTimeoutMs }),
    });
  } catch (error) {
    await close(server);
    throw error;
  }
  const httpApp = container.resolve("httpApp");
  server.off("request", starting);
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
        requestLogger?.warn(
          {
            event: "http.request.interrupted",
            durationMs: Date.now() - startedAt,
          },
          "HTTP connection closed before the response completed",
        );
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
  const accessService = container.resolve("accessService");
  const socketContexts = new WeakMap<IncomingMessage, { context: AccessContext; authorization: string | undefined }>();
  const languageServer = new WebSocketServer({
    server,
    path: "/lsp",
    maxPayload: 1_048_576,
    handleProtocols: (protocols) => (protocols.has("trust-lsp") ? "trust-lsp" : false),
    verifyClient: (info, done) => {
      const authorization = languageServerAuthorization(info.req);
      const origin = info.req.headers.origin;
      if (
        accessService.shared &&
        !allowedBrowserOrigin(origin, browserAuthentication, developmentAuthentication, accessConfiguration)
      ) {
        done(false, 403, "Access denied");
        return;
      }
      void accessService
        .authenticate(authorization)
        .then((context) => {
          authorizeLanguageServer(accessService, context);
          socketContexts.set(info.req, { context, authorization });
          done(true);
        })
        .catch(() => done(false, 403, "Access denied"));
    },
  });
  const languageOperations = container.resolve("operationCatalog");
  const languageProcedures = container.resolve("procedures");
  languageServer.on("connection", (webSocket, request) => {
    const authenticated = socketContexts.get(request);
    if (!authenticated) {
      webSocket.close(1008, "Access denied");
      return;
    }
    const expiry = matchAccessContext(authenticated.context, {
      local: () => undefined,
      authenticated: (context) => context.expiresAt,
    });
    const timer =
      expiry === undefined || expiry === null
        ? undefined
        : setTimeout(() => webSocket.close(1008, "Authentication expired"), Math.max(0, expiry * 1000 - Date.now()));
    timer?.unref();
    webSocket.once("close", () => {
      if (timer) clearTimeout(timer);
    });
    logger?.info({ event: "lsp.connection.opened", component: "lsp" }, "LSP connection opened");
    webSocket.on("error", (error) => {
      logger?.error({ err: error, event: "lsp.connection.failed", component: "lsp" }, "LSP connection failed");
    });
    webSocket.on("close", (code) => {
      logger?.info({ event: "lsp.connection.closed", component: "lsp", code }, "LSP connection closed");
    });
    startTrustWebSocketLanguageServer(
      languageServerSocket(webSocket, async () => {
        const current = await accessService.authenticate(authenticated.authorization);
        authorizeLanguageServer(accessService, current);
      }),
      {
        operations: () => languageOperations.list(),
        procedures: async () => (await languageProcedures.list()).map((published) => published.procedure),
      },
    );
  });

  return {
    host,
    port: address.port,
    close: async () => {
      for (const client of languageServer.clients) client.close();
      await new Promise<void>((resolve, reject) =>
        languageServer.close((error) => (error ? reject(error) : resolve())),
      );
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

function authorizeLanguageServer(accessService: AccessService, context: AccessContext): void {
  for (const action of ["procedure.read", "procedure.compile", "operation.read", "operation.compile"])
    accessService.authorize(context, action);
}

/** Browser WebSocket has no Authorization-header API. The bearer travels in a non-selected protocol header, never a URL or server-selected protocol. */
function languageServerAuthorization(request: IncomingMessage): string | undefined {
  if (request.headers.authorization) return request.headers.authorization;
  const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()) ?? [];
  const credentials = protocols.filter((value) => value.startsWith("bearer."));
  if (!protocols.includes("trust-lsp") || credentials.length !== 1 || credentials[0]!.length > 44000) return undefined;
  const encoded = credentials[0]!.slice(7);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  return `Bearer ${Buffer.from(encoded, "base64url").toString("utf8")}`;
}
