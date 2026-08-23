import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

test("the server manager refuses a stale SQLite schema before starting tmux", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "trust-stale-schema-"));
  const session = `trust-stale-${process.pid}-${Date.now().toString(36)}`;
  const database = new DatabaseSync(path.join(stateDirectory, "runtime.sqlite"));
  database.exec("CREATE TABLE attempts (attempt_handle TEXT PRIMARY KEY) STRICT");
  database.close();
  try {
    await assert.rejects(
      execute(
        process.execPath,
        [path.join(repositoryRoot, "environments/trust-test/scripts/server.ts"), "start"],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            TRUST_SERVER_STATE_DIRECTORY: stateDirectory,
            TRUST_SERVER_TMUX_SESSION: session,
            TRUST_SERVER_PORT: String(await availablePort()),
          },
          timeout: 30_000,
        },
      ),
      (error: unknown) => {
        const output = error instanceof Error
          ? `${error.message}\n${String((error as Error & { stderr?: unknown }).stderr ?? "")}`
          : String(error);
        assert.match(output, /SQLite database schema is incompatible/);
        assert.match(output, /node environments\/trust-test\/scripts\/server\.ts reset/);
        return true;
      },
    );
    await assert.rejects(execute("tmux", ["has-session", "-t", session]));
  } finally {
    await execute("tmux", ["kill-session", "-t", session]).catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("the server manager refuses a healthy runtime owned outside its tmux session", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "trust-foreign-runtime-"));
  const session = `trust-foreign-${process.pid}-${Date.now().toString(36)}`;
  const foreignRuntime = createHttpServer((request, response) => {
    if (request.url === "/health") response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    foreignRuntime.once("error", reject);
    foreignRuntime.listen(0, "127.0.0.1", resolve);
  });
  const address = foreignRuntime.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await assert.rejects(
      execute(
        process.execPath,
        [path.join(repositoryRoot, "environments/trust-test/scripts/server.ts"), "start"],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            TRUST_SERVER_STATE_DIRECTORY: stateDirectory,
            TRUST_SERVER_TMUX_SESSION: session,
            TRUST_SERVER_PORT: String(port),
          },
          timeout: 30_000,
        },
      ),
      /already owned outside tmux session/,
    );
    await assert.rejects(execute("tmux", ["has-session", "-t", session]));
  } finally {
    await new Promise<void>((resolve, reject) => foreignRuntime.close((error) => error ? reject(error) : resolve()));
    await execute("tmux", ["kill-session", "-t", session]).catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("the Node server manager resets and reuses separate backend and live-reload frontend sessions", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "trust-server-manager-"));
  const sessionSuffix = `${process.pid}-${Date.now().toString(36)}`;
  const backendSession = `trust-backend-${sessionSuffix}`;
  const frontendSession = `trust-frontend-${sessionSuffix}`;
  const port = await availablePort();
  let webPort = await availablePort();
  while (webPort === port) webPort = await availablePort();
  const liveReloadName = `.trust-live-reload-${sessionSuffix}.ts`;
  const liveReloadFile = path.join(repositoryRoot, "apps/trust-web/src", liveReloadName);
  const liveReloadPath = `/src/${liveReloadName}`;
  const environment = {
    ...process.env,
    TRUST_SERVER_STATE_DIRECTORY: stateDirectory,
    TRUST_SERVER_TMUX_SESSION: backendSession,
    TRUST_WEB_TMUX_SESSION: frontendSession,
    TRUST_SERVER_PORT: String(port),
    TRUST_WEB_PORT: String(webPort),
  };
  try {
    const reset = await execute(
      process.execPath,
      [path.join(repositoryRoot, "environments/trust-test/scripts/server.ts"), "reset", "--web"],
      { cwd: repositoryRoot, env: environment, timeout: 120_000 },
    );
    assert.match(reset.stdout, /TRUST server: started with an empty database/);
    assert.match(reset.stdout, /TRUST seed: git-status@2\.0\.0/);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${webPort}/health`)).status, 200);
    assert.match(await paneStartCommand(backendSession, "backend"), /npm start/);
    assert.doesNotMatch(await pane(backendSession, "backend"), /tsx watch/);
    assert.match(await paneStartCommand(frontendSession, "frontend"), /npm run dev:web/);
    await observeFrontendLiveReload(webPort, liveReloadFile, liveReloadPath);

    const start = await execute(
      process.execPath,
      [path.join(repositoryRoot, "environments/trust-test/scripts/server.ts"), "start", "--web"],
      { cwd: repositoryRoot, env: environment, timeout: 30_000 },
    );
    assert.match(start.stdout, /TRUST server: already available/);

    const frontendPane = await paneId(frontendSession, "frontend");
    const resetBackend = await execute(
      process.execPath,
      [path.join(repositoryRoot, "environments/trust-test/scripts/server.ts"), "reset"],
      { cwd: repositoryRoot, env: environment, timeout: 120_000 },
    );
    assert.match(resetBackend.stdout, /TRUST server: started with an empty database/);
    assert.equal(await paneId(frontendSession, "frontend"), frontendPane);
    assert.equal((await fetch(`http://127.0.0.1:${webPort}/health`)).status, 200);

    const starts = occurrences(await pane(backendSession, "backend"), "TRUST runtime listening on 127.0.0.1:");

    await execute(
      "npm",
      ["run", "build", "--workspace=@trust/runtime"],
      { cwd: repositoryRoot, env: environment, timeout: 120_000 },
    );
    await waitForHealth(port);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(
      occurrences(await pane(backendSession, "backend"), "TRUST runtime listening on 127.0.0.1:"),
      starts,
      "building dist must not restart the source runtime",
    );

  } finally {
    await rm(liveReloadFile, { force: true });
    await execute("tmux", ["kill-session", "-t", backendSession]).catch(() => undefined);
    await execute("tmux", ["kill-session", "-t", frontendSession]).catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  return port;
}

async function pane(session: string, window: string): Promise<string> {
  return (await execute("tmux", [
    "capture-pane",
    "-pt",
    `${session}:${window}`,
    "-S",
    "-2000",
  ])).stdout;
}

async function paneStartCommand(session: string, window: string): Promise<string> {
  return (await execute("tmux", [
    "display-message",
    "-p",
    "-t",
    `${session}:${window}`,
    "#{pane_start_command}",
  ])).stdout;
}

async function paneId(session: string, window: string): Promise<string> {
  return (await execute("tmux", [
    "display-message",
    "-p",
    "-t",
    `${session}:${window}`,
    "#{pane_id}",
  ])).stdout.trim();
}

async function observeFrontendLiveReload(webPort: number, file: string, publicPath: string): Promise<void> {
  const before = "export const trustLiveReload = 'before';\n";
  const after = "export const trustLiveReload = 'after';\n";
  await writeFile(file, before, "utf8");
  const initial = await fetch(`http://127.0.0.1:${webPort}${publicPath}`);
  assert.equal(initial.status, 200);
  assert.match(await initial.text(), /before/);

  const socket = new WebSocket(`ws://127.0.0.1:${webPort}/`, "vite-hmr");
  try {
    await waitForWebSocketOpen(socket);
    const update = waitForViteUpdate(socket, publicPath);
    await writeFile(file, after, "utf8");
    await update;
    const refreshed = await fetch(`http://127.0.0.1:${webPort}${publicPath}?t=${Date.now()}`);
    assert.equal(refreshed.status, 200);
    assert.match(await refreshed.text(), /after/);
  } finally {
    socket.close();
  }
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Vite HMR socket did not open within 15 seconds")), 15_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForViteUpdate(socket: WebSocket, publicPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Vite did not live-reload ${publicPath} within 15 seconds`)), 15_000);
    socket.on("message", (data) => {
      const message = data.toString();
      if (!message.includes(publicPath)) return;
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TRUST runtime did not remain available after a development rebuild");
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}
