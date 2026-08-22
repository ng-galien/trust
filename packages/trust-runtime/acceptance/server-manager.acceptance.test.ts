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

test("the Node server manager resets, reuses and live-reloads an isolated tmux server", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "trust-server-manager-"));
  const session = `trust-acceptance-${process.pid}-${Date.now().toString(36)}`;
  const port = await availablePort();
  const watchedFile = path.join(stateDirectory, "reload.ts");
  await writeFile(watchedFile, "0\n", "utf8");
  const environment = {
    ...process.env,
    TRUST_SERVER_STATE_DIRECTORY: stateDirectory,
    TRUST_SERVER_TMUX_SESSION: session,
    TRUST_SERVER_PORT: String(port),
    TRUST_DEV_WATCH_INCLUDE: watchedFile,
  };
  try {
    const reset = await execute(
      process.execPath,
      [path.join(repositoryRoot, "environments/trust-test/scripts/server.ts"), "reset"],
      { cwd: repositoryRoot, env: environment, timeout: 120_000 },
    );
    assert.match(reset.stdout, /TRUST server: started with an empty database/);
    assert.match(reset.stdout, /TRUST seed: git-status@2\.0\.0/);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    const start = await execute(
      process.execPath,
      [path.join(repositoryRoot, "environments/trust-test/scripts/server.ts"), "start"],
      { cwd: repositoryRoot, env: environment, timeout: 30_000 },
    );
    assert.match(start.stdout, /TRUST server: already available/);

    const before = await waitForWatch(session);
    const restarts = occurrences(before, "TRUST runtime listening on 127.0.0.1:");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await writeFile(watchedFile, "1\n", "utf8");
    const after = await waitForRestart(session, restarts);
    assert.match(after, /TRUST runtime listening on 127\.0\.0\.1:/);
    await writeFile(watchedFile, "2\n", "utf8");
    await waitForRestart(session, restarts + 1);

    await execute(
      "npm",
      ["run", "build", "--workspace=@trust/runtime"],
      { cwd: repositoryRoot, env: environment, timeout: 120_000 },
    );
    await waitForHealth(port);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(
      occurrences(await pane(session), "TRUST runtime listening on 127.0.0.1:"),
      restarts + 2,
      "building dist must not restart the source runtime",
    );

  } finally {
    await rm(watchedFile, { force: true });
    await execute("tmux", ["kill-session", "-t", session]).catch(() => undefined);
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

async function pane(session: string): Promise<string> {
  return (await execute("tmux", [
    "capture-pane",
    "-pt",
    `${session}:server`,
    "-S",
    "-2000",
  ])).stdout;
}

async function waitForRestart(session: string, previousRestarts: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  let output = "";
  while (Date.now() < deadline) {
    output = await pane(session);
    if (occurrences(output, "TRUST runtime listening on 127.0.0.1:") > previousRestarts) return output;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`TRUST runtime did not live-reload within 15 seconds\n${output}`);
}

async function waitForWatch(session: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const output = await pane(session);
    if (/Found 0 errors\. Watching for file changes/.test(output)) return output;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TRUST TypeScript watcher did not become ready within 30 seconds");
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
