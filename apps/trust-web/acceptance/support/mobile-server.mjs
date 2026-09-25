import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "trust-mobile-browser-"));
const operationsDirectory = path.join(temporary, "operations");
await mkdir(operationsDirectory);
const children = [];
const reader = createServer((request, response) => {
  if (
    (request.headers.origin && request.headers.origin !== "http://127.0.0.1:4400") ||
    (request.headers.referer && !request.headers.referer.startsWith("http://127.0.0.1:4400/"))
  ) {
    response.writeHead(403).end();
    return;
  }
  if (request.url === "/documents/example/read") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><title>Document reader</title><h1>Example document</h1><script src="/mobile/apps/maket/reader.js"></script>',
    );
  } else if (request.url === "/reader.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(
      'const protocol=location.protocol==="https:"?"wss":"ws";const ws=new WebSocket(protocol+"://"+location.host+"/mobile/apps/maket/ws");ws.onmessage=event=>{document.body.dataset.connection=event.data};',
    );
  } else response.writeHead(404).end();
});
const readerSockets = new WebSocketServer({ noServer: true });
reader.on("upgrade", (request, socket, head) => {
  if (request.headers.origin !== "http://127.0.0.1:4400") {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  readerSockets.handleUpgrade(request, socket, head, (client) => client.send("connected"));
});
await new Promise((resolve) => reader.listen(4400, "127.0.0.1", resolve));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }),
  );
  for (const client of readerSockets.clients) client.terminate();
  await new Promise((resolve) => readerSockets.close(resolve));
  await new Promise((resolve) => reader.close(resolve));
  await rm(temporary, { recursive: true, force: true });
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void close());
function start(args, cwd, environment) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...environment }, stdio: "inherit" });
  children.push(child);
  child.once("exit", () => {
    if (!closing) void close();
  });
}
async function wait(url) {
  for (let index = 0; index < 300; index++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server unavailable: ${url}`);
}
const registry = path.join(temporary, "extensions.json");
await writeFile(
  registry,
  JSON.stringify({
    extensions: [
      {
        manifest: path.join(root, "extensions/mobile-companion/extension.json"),
        configuration: { databasePath: path.join(temporary, "pglite"), pushSubject: "mailto:mobile@example.com" },
        environment: "local",
        grants: ["plans.read", "plans.subscribe"],
        autoStart: false,
      },
    ],
  }),
);
start([path.join(root, "packages/trust-runtime/dist/src/index.js")], root, {
  TRUST_HOST: "127.0.0.1",
  TRUST_PORT: "4399",
  TRUST_STORAGE: "pglite",
  TRUST_PGLITE_DIRECTORY: path.join(temporary, "runtime-pglite"),
  TRUST_OPERATIONS_DIRECTORY: operationsDirectory,
  TRUST_EXTENSIONS_FILE: registry,
});
await wait("http://127.0.0.1:4399/health");
start(
  [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", "4179"],
  path.join(root, "apps/trust-web"),
  {
    TRUST_RUNTIME_URL: "http://127.0.0.1:4399",
    TRUST_WEB_PORT: "4179",
    TRUST_MOBILE_UPSTREAMS: JSON.stringify({ maket: { url: "http://127.0.0.1:4400", pathMode: "strip" } }),
  },
);
await wait("http://127.0.0.1:4179/health");
await new Promise(() => {});
