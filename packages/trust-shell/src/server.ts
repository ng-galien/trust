import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, connect as connectSocket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { TrustInstallation } from "./installation.js";

const PROXY_PATHS = ["/health", "/rpc", "/mcp", "/otlp", "/events"];

export interface TrustServerOptions {
  readonly installation: TrustInstallation;
  readonly host?: string;
  readonly runtimePort?: number;
  readonly webPort?: number;
  readonly stateDirectory: string;
  readonly runtimeEnvironment?: Readonly<Record<string, string>>;
}

export interface TrustServerStatus {
  readonly running: boolean;
  readonly url: string;
  readonly runtimeAvailable: boolean;
}

export interface RunningTrustServer {
  readonly url: string;
  readonly runtimeUrl: string;
  close(): Promise<void>;
}

export async function startTrustServer(options: TrustServerOptions): Promise<RunningTrustServer> {
  const host = options.host ?? "127.0.0.1";
  const runtimePort = validatePort(options.runtimePort ?? 4318, "runtime");
  const webPort = validatePort(options.webPort ?? 4173, "web");
  if (runtimePort === webPort) throw new TypeError("Runtime and web ports must be different");
  const stateDirectory = absoluteDirectory(options.stateDirectory, "Server state directory");
  await mkdir(stateDirectory, { recursive: true });
  const operationsDirectory = path.join(stateDirectory, "operations");
  await prepareOperationsDirectory(options.installation.operationsDirectory, operationsDirectory);
  await Promise.all([assertPortAvailable(host, runtimePort), assertPortAvailable(host, webPort)]);

  const instance = randomUUID();
  const runtime = spawn(process.execPath, [options.installation.runtimeEntry], {
    cwd: options.installation.root,
    env: {
      ...process.env,
      ...options.runtimeEnvironment,
      TRUST_HOST: host,
      TRUST_PORT: String(runtimePort),
      TRUST_DATABASE_PATH: path.join(stateDirectory, "runtime.sqlite"),
      TRUST_OPERATIONS_DIRECTORY: operationsDirectory,
      TRUST_RUNTIME_INSTANCE: instance,
      TRUST_RUNTIME_LOG_PATH: path.join(stateDirectory, "runtime.log"),
      TRUST_SEMANTIC_AUTHORITY: `${host}:${runtimePort}`,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await waitForRuntime(runtime, `http://${host}:${runtimePort}/health`, instance);
    const web = createWebServer(options.installation.webDirectory, host, runtimePort);
    await listen(web, host, webPort);
    return {
      url: `http://${host}:${webPort}`,
      runtimeUrl: `http://${host}:${runtimePort}`,
      close: async () => {
        await closeServer(web);
        await stopChild(runtime);
      },
    };
  } catch (error) {
    await stopChild(runtime);
    throw error;
  }
}

async function prepareOperationsDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const builtIns = (await readdir(source)).filter((name) => name.endsWith(".feature"));
  await Promise.all(builtIns.map(async (name) => {
    try {
      await copyFile(path.join(source, name), path.join(destination, name), constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }));
}

export async function readTrustServerStatus(host = "127.0.0.1", webPort = 4173): Promise<TrustServerStatus> {
  validatePort(webPort, "web");
  const url = `http://${host}:${webPort}`;
  try {
    const [page, health] = await Promise.all([
      fetch(url, { signal: AbortSignal.timeout(1_500) }),
      fetch(`${url}/health`, { signal: AbortSignal.timeout(1_500) }),
    ]);
    const runtimeAvailable = health.ok && await isTrustHealthResponse(health);
    const pageIsTrust = page.ok && (await page.text()).includes("<title>TRUST</title>");
    return { running: pageIsTrust && runtimeAvailable, url, runtimeAvailable };
  } catch {
    return { running: false, url, runtimeAvailable: false };
  }
}

async function isTrustHealthResponse(response: Response): Promise<boolean> {
  try {
    const payload = await response.json() as { readonly status?: unknown; readonly service?: unknown };
    return payload.status === "ok" && payload.service === "trust-runtime";
  } catch {
    return false;
  }
}

function createWebServer(webDirectory: string, runtimeHost: string, runtimePort: number): Server {
  const server = createServer((request, response) => {
    const pathname = requestPath(request.url);
    if (PROXY_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      proxyHttp(request, response, runtimeHost, runtimePort);
      return;
    }
    void serveWebFile(webDirectory, pathname, request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    if (requestPath(request.url) !== "/lsp") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    proxyWebSocket(request, socket, head, runtimeHost, runtimePort);
  });
  return server;
}

function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  runtimeHost: string,
  runtimePort: number,
): void {
  const upstream = httpRequest({
    host: runtimeHost,
    port: runtimePort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: `${runtimeHost}:${runtimePort}` },
  }, (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`TRUST runtime unavailable: ${error.message}\n`);
  });
  request.pipe(upstream);
}

function proxyWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  runtimeHost: string,
  runtimePort: number,
): void {
  const upstream = connectSocket(runtimePort, runtimeHost);
  upstream.once("connect", () => {
    upstream.write(`${request.method ?? "GET"} ${request.url ?? "/lsp"} HTTP/${request.httpVersion}\r\n`);
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (name !== undefined && value !== undefined) upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write("\r\n");
    if (head.byteLength > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

async function serveWebFile(
  webDirectory: string,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(webDirectory, relative || "index.html");
  const root = `${path.resolve(webDirectory)}${path.sep}`;
  if (candidate !== path.resolve(webDirectory) && !candidate.startsWith(root)) {
    response.writeHead(404).end();
    return;
  }
  const file = await regularFile(candidate) ? candidate : path.join(webDirectory, "index.html");
  try {
    const information = await stat(file);
    response.writeHead(200, {
      "content-length": information.size,
      "content-type": contentType(file),
      "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}

async function regularFile(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isFile();
  } catch {
    return false;
  }
}

function contentType(file: string): string {
  switch (path.extname(file)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

async function waitForRuntime(child: ChildProcess, url: string, instance: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`TRUST runtime exited during startup with code ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && response.headers.get("x-trust-runtime-instance") === instance) return;
    } catch {}
    await delay(100);
  }
  throw new Error("TRUST runtime did not become healthy within 20 seconds");
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  const available = await new Promise<boolean>((resolve) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
  if (!available) throw new Error(`TRUST port is already in use: ${host}:${port}`);
}

function validatePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`Invalid TRUST ${label} port: ${value}`);
  }
  return value;
}

function absoluteDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  return path.resolve(value);
}

function requestPath(value: string | undefined): string {
  if (value === undefined) return "/";
  try {
    return new URL(value, "http://trust.invalid").pathname;
  } catch {
    return "/";
  }
}
