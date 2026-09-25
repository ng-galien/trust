import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as connectSocket, createServer as createNetServer } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { TrustInstallation } from "./installation.js";

const PROXY_PATHS = ["/health", "/rpc", "/mcp", "/otlp", "/events", "/extensions"];
const mobileGatewaySockets = new WeakMap<Server, Set<Duplex>>();

export interface TrustServerOptions {
  readonly installation: TrustInstallation;
  readonly host?: string;
  readonly runtimePort?: number;
  readonly webPort?: number;
  readonly stateDirectory: string;
  readonly runtimeEnvironment?: Readonly<Record<string, string>>;
  /** Trusted loopback upstreams; browser paths never select a target URL. */
  readonly mobileUpstreams?: Readonly<Record<string, { url: string; pathMode?: "strip" | "preserve" }>>;
  /** Optional password gate for every browser-visible web route and upgrade. */
  readonly webAccessPassword?: string;
}

type MobileUpstream = { readonly host: "127.0.0.1"; readonly port: number; readonly pathMode: "strip" | "preserve" };

export function parseMobileUpstreams(value: string | undefined): Readonly<Record<string, MobileUpstream>> {
  if (value === undefined || value === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Invalid TRUST_MOBILE_UPSTREAMS JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Invalid TRUST_MOBILE_UPSTREAMS map");
  const result: Record<string, MobileUpstream> = {};
  for (const [id, raw] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !raw || typeof raw !== "object" || Array.isArray(raw))
      throw new TypeError("Invalid mobile upstream entry");
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => !["url", "pathMode"].includes(key)) ||
      typeof entry.url !== "string" ||
      (entry.pathMode !== undefined && entry.pathMode !== "strip" && entry.pathMode !== "preserve")
    )
      throw new TypeError("Invalid mobile upstream entry");
    let target: URL;
    try {
      target = new URL(entry.url);
    } catch {
      throw new TypeError("Invalid mobile upstream URL");
    }
    if (
      target.protocol !== "http:" ||
      target.hostname !== "127.0.0.1" ||
      !target.port ||
      target.pathname !== "/" ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    )
      throw new TypeError("Mobile upstreams must be exact loopback HTTP origins");
    result[id] = {
      host: "127.0.0.1",
      port: validatePort(Number(target.port), "mobile upstream"),
      pathMode: entry.pathMode === "preserve" ? "preserve" : "strip",
    };
  }
  return result;
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
  const webAccessPassword = options.webAccessPassword ?? process.env.TRUST_WEB_ACCESS_PASSWORD;
  if (webAccessPassword && webAccessPassword.length < 20)
    throw new TypeError("TRUST_WEB_ACCESS_PASSWORD must contain at least 20 characters");
  if (runtimePort === webPort) throw new TypeError("Runtime and web ports must be different");
  const stateDirectory = absoluteDirectory(options.stateDirectory, "Server state directory");
  await mkdir(stateDirectory, { recursive: true });
  const operationsDirectory = path.join(stateDirectory, "operations");
  await prepareOperationsDirectory(options.installation.operationsDirectory, operationsDirectory);
  await Promise.all([assertPortAvailable(host, runtimePort), assertPortAvailable(host, webPort)]);

  const instance = randomUUID();
  const runtimeEnvironment = { ...process.env, ...options.runtimeEnvironment };
  delete runtimeEnvironment.TRUST_WEB_ACCESS_PASSWORD;
  const runtime = spawn(process.execPath, [options.installation.runtimeEntry], {
    cwd: options.installation.root,
    env: {
      ...runtimeEnvironment,
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
    const mobileUpstreams =
      options.mobileUpstreams === undefined
        ? parseMobileUpstreams(process.env.TRUST_MOBILE_UPSTREAMS)
        : parseMobileUpstreams(JSON.stringify(options.mobileUpstreams));
    const web = createWebServer(
      options.installation.webDirectory,
      host,
      runtimePort,
      mobileUpstreams,
      webAccessPassword,
    );
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
  await Promise.all(
    builtIns.map(async (name) => {
      try {
        await copyFile(path.join(source, name), path.join(destination, name), constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }),
  );
}

export async function readTrustServerStatus(host = "127.0.0.1", webPort = 4173): Promise<TrustServerStatus> {
  validatePort(webPort, "web");
  const url = `http://${host}:${webPort}`;
  try {
    const headers = process.env.TRUST_WEB_ACCESS_PASSWORD
      ? { authorization: `Basic ${Buffer.from(`mobile:${process.env.TRUST_WEB_ACCESS_PASSWORD}`).toString("base64")}` }
      : undefined;
    const [page, health] = await Promise.all([
      fetch(url, { ...(headers ? { headers } : {}), signal: AbortSignal.timeout(1_500) }),
      fetch(`${url}/health`, { ...(headers ? { headers } : {}), signal: AbortSignal.timeout(1_500) }),
    ]);
    const runtimeAvailable = health.ok && (await isTrustHealthResponse(health));
    const pageIsTrust = page.ok && (await page.text()).includes("<title>TRUST</title>");
    return { running: pageIsTrust && runtimeAvailable, url, runtimeAvailable };
  } catch {
    return { running: false, url, runtimeAvailable: false };
  }
}

async function isTrustHealthResponse(response: Response): Promise<boolean> {
  try {
    const payload = (await response.json()) as { readonly status?: unknown; readonly service?: unknown };
    return payload.status === "ok" && payload.service === "trust-runtime";
  } catch {
    return false;
  }
}

function createWebServer(
  webDirectory: string,
  runtimeHost: string,
  runtimePort: number,
  mobileUpstreams: Readonly<Record<string, MobileUpstream>>,
  webAccessPassword?: string,
): Server {
  const expectedAuthorization = webAccessPassword
    ? `Basic ${Buffer.from(`mobile:${webAccessPassword}`).toString("base64")}`
    : null;
  const server = createServer((request, response) => {
    if (!authorized(request, expectedAuthorization)) {
      response.writeHead(401, accessChallenge()).end();
      return;
    }
    const pathname = requestPath(request.url);
    if (pathname === "/mobile/mobile-comp" || pathname === "/mobile/mobile-comp/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      const query = new URL(request.url ?? "", "http://localhost").search;
      response.writeHead(302, { location: `/mobile/mobile-companion/${query}`, "cache-control": "no-store" }).end();
      return;
    }
    const gateway = mobileGatewayRequest(request.url, mobileUpstreams);
    if (gateway) {
      proxyHttp(request, response, gateway.upstream.host, gateway.upstream.port, gateway.path, true);
      return;
    }
    if (pathname.startsWith("/mobile/apps/")) {
      response.writeHead(404).end();
      return;
    }
    const extensionNavigation =
      request.method === "GET" &&
      (request.headers.accept ?? "").split(",").some((value) => value.trim().split(";", 1)[0] === "text/html") &&
      /^\/extensions(?:\/[^/]+)?$/.test(pathname);
    if (
      !extensionNavigation &&
      PROXY_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
    ) {
      proxyHttp(request, response, runtimeHost, runtimePort);
      return;
    }
    void serveWebFile(webDirectory, pathname, request, response);
  });
  const upgraded = new Set<Duplex>();
  mobileGatewaySockets.set(server, upgraded);
  server.on("upgrade", (request, socket, head) => {
    if (!authorized(request, expectedAuthorization)) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="TRUST mobile", charset="UTF-8"\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    const gateway = mobileGatewayRequest(request.url, mobileUpstreams);
    if (gateway) {
      upgraded.add(socket);
      socket.once("close", () => upgraded.delete(socket));
      proxyWebSocket(request, socket, head, gateway.upstream.host, gateway.upstream.port, gateway.path, true);
      return;
    }
    if (requestPath(request.url) !== "/lsp") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    proxyWebSocket(request, socket, head, runtimeHost, runtimePort);
  });
  return server;
}

function authorized(request: IncomingMessage, expected: string | null): boolean {
  if (expected === null) return true;
  const received = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

function accessChallenge(): Record<string, string> {
  return { "www-authenticate": 'Basic realm="TRUST mobile", charset="UTF-8"', "cache-control": "no-store" };
}

function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  runtimeHost: string,
  runtimePort: number,
  upstreamPath = request.url,
  rewriteOrigin = false,
): void {
  const headers = { ...request.headers };
  if (headers.authorization?.startsWith("Basic ")) delete headers.authorization;
  const upstream = httpRequest(
    {
      host: runtimeHost,
      port: runtimePort,
      method: request.method,
      path: upstreamPath,
      headers: {
        ...headers,
        host: `${runtimeHost}:${runtimePort}`,
        ...(rewriteOrigin && request.headers.origin ? { origin: `http://${runtimeHost}:${runtimePort}` } : {}),
        ...(rewriteOrigin && request.headers.referer ? { referer: `http://${runtimeHost}:${runtimePort}/` } : {}),
      },
    },
    (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`TRUST runtime unavailable: ${error.message}\n`);
  });
  response.once("close", () => upstream.destroy());
  request.pipe(upstream);
}

function proxyWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  runtimeHost: string,
  runtimePort: number,
  upstreamPath = request.url,
  rewriteOrigin = false,
): void {
  const upstream = connectSocket(runtimePort, runtimeHost);
  upstream.once("connect", () => {
    upstream.write(`${request.method ?? "GET"} ${upstreamPath ?? "/lsp"} HTTP/${request.httpVersion}\r\n`);
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (name?.toLowerCase() === "authorization" && value?.startsWith("Basic ")) continue;
      if (name?.toLowerCase() === "host") upstream.write(`Host: ${runtimeHost}:${runtimePort}\r\n`);
      else if (name?.toLowerCase() === "origin" && rewriteOrigin)
        upstream.write(`Origin: http://${runtimeHost}:${runtimePort}\r\n`);
      else if (name?.toLowerCase() === "referer" && rewriteOrigin)
        upstream.write(`Referer: http://${runtimeHost}:${runtimePort}/\r\n`);
      else if (name !== undefined && value !== undefined) upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write("\r\n");
    if (head.byteLength > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function mobileGatewayRequest(
  raw: string | undefined,
  upstreams: Readonly<Record<string, MobileUpstream>>,
): { upstream: MobileUpstream; path: string } | undefined {
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw, "http://trust.invalid");
  } catch {
    return undefined;
  }
  const match = /^\/mobile\/apps\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(url.pathname);
  if (!match?.[1]) return undefined;
  const upstream = upstreams[match[1]];
  if (!upstream) return undefined;
  const path = upstream.pathMode === "preserve" ? url.pathname : match[2] || "/";
  return { upstream, path: `${path}${url.search}` };
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
  const file = (await regularFile(candidate)) ? candidate : path.join(webDirectory, "index.html");
  try {
    const information = await stat(file);
    response.writeHead(200, {
      "content-length": information.size,
      "content-type": contentType(file),
      "cache-control":
        file.endsWith("index.html") || file.endsWith("/sw.js") || file.endsWith(".webmanifest")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
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
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
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
    for (const socket of mobileGatewaySockets.get(server) ?? []) socket.destroy();
    server.close((error) => (error ? reject(error) : resolve()));
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
