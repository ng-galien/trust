import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const trustCli = path.join(repositoryRoot, "packages/trust-shell/bin/trust.js");

test("trust runner deploy installs the complete Runner at the exact absolute destination", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trust-runner-deploy-"));
  const destination = path.join(root, "agent-runner");
  const environment = { ...process.env, TRUST_INSTALL_ROOT: repositoryRoot };
  try {
    const first = await execute(process.execPath, [trustCli, "runner", "deploy", destination], {
      cwd: repositoryRoot,
      env: environment,
      timeout: 30_000,
    });
    assert.match(first.stdout, new RegExp(`TRUST Runner deployed at ${escapeRegExp(destination)}`));
    for (const relative of [
      "SKILL.md",
      "agents/openai.yaml",
      "references/results.md",
      "scripts/run.js",
      "scripts/mcp-stdio.js",
      "scripts/trial.js",
    ]) {
      assert.notEqual((await readFile(path.join(destination, relative))).byteLength, 0, relative);
    }

    await writeFile(path.join(destination, "obsolete.txt"), "old deployment", "utf8");
    await execute(process.execPath, [trustCli, "runner", "deploy", destination], {
      cwd: repositoryRoot,
      env: environment,
      timeout: 30_000,
    });
    await assert.rejects(readFile(path.join(destination, "obsolete.txt")), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".trust-staging-") || name.includes(".trust-backup-")),
      [],
    );

    await assert.rejects(
      execute(process.execPath, [trustCli, "runner", "deploy", "relative-runner"], {
        cwd: repositoryRoot,
        env: environment,
      }),
      /Runner destination must be an absolute path/,
    );
    await assert.rejects(
      execute(process.execPath, [trustCli, "runner", "deploy", path.parse(destination).root], {
        cwd: repositoryRoot,
        env: environment,
      }),
      /Runner destination is unsafe/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trust server start serves the compiled UI and server status observes its public health", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "trust-shell-server-"));
  const runtimePort = await availablePort();
  let webPort = await availablePort();
  while (webPort === runtimePort) webPort = await availablePort();
  const environment = {
    ...process.env,
    TRUST_INSTALL_ROOT: repositoryRoot,
    TRUST_SERVER_STATE_DIRECTORY: stateDirectory,
    TRUST_PORT: String(runtimePort),
    TRUST_WEB_PORT: String(webPort),
  };
  const server = spawn(process.execPath, [trustCli, "server", "start"], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk: string) => { stdout += chunk; });
  server.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await waitFor(`http://127.0.0.1:${webPort}/health`, server, () => stderr);
    const page = await fetch(`http://127.0.0.1:${webPort}/docs`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>TRUST<\/title>/);

    const status = await execute(process.execPath, [trustCli, "server", "status"], {
      cwd: repositoryRoot,
      env: environment,
      timeout: 10_000,
    });
    assert.match(status.stdout, new RegExp(`TRUST server: running at http://127\\.0\\.0\\.1:${webPort}`));
    assert.match(stdout, new RegExp(`TRUST server: running at http://127\\.0\\.0\\.1:${webPort}`));
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    }
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("trust registry commands persist and synchronize an HTTP registry through the public server", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "trust-shell-registry-"));
  const runtimePort = await availablePort();
  let webPort = await availablePort();
  while (webPort === runtimePort) webPort = await availablePort();
  const operation = (await readFile(path.join(repositoryRoot, "assets/operations/git.head-read.feature"), "utf8"))
    .replaceAll("git.head-read", "registry.git-head-read");
  const procedure = (await readFile(path.join(repositoryRoot, "assets/procedures/00-git-status.feature"), "utf8"))
    .replace("@procedure:git-status", "@procedure:registry-git-status")
    .replace('Operation "git.head-read"', 'Operation "registry.git-head-read"');
  const index = JSON.stringify({
    contract: "trust.registry-index@1",
    artifacts: [
      {
        kind: "operation",
        path: "operations/registry.git-head-read.feature",
        name: "registry.git-head-read",
        version: "1.0.0",
        sha256: createHash("sha256").update(operation).digest("hex"),
      },
      {
        kind: "procedure",
        path: "procedures/registry-git-status.feature",
        name: "registry-git-status",
        version: "2.0.0",
        sha256: createHash("sha256").update(procedure).digest("hex"),
      },
    ],
  });
  const registry = createHttpServer((request, response) => {
    const body = request.url === "/trust-registry.json"
      ? index
      : request.url === "/operations/registry.git-head-read.feature"
        ? operation
        : request.url === "/procedures/registry-git-status.feature"
          ? procedure
          : undefined;
    if (body === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", request.url?.endsWith(".json") ? "application/json" : "text/plain");
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    registry.once("error", reject);
    registry.listen(0, "127.0.0.1", resolve);
  });
  const registryAddress = registry.address();
  assert.ok(registryAddress !== null && typeof registryAddress !== "string");
  const registryUrl = `http://127.0.0.1:${registryAddress.port}/trust-registry.json`;
  const environment = {
    ...process.env,
    TRUST_INSTALL_ROOT: repositoryRoot,
    TRUST_SERVER_STATE_DIRECTORY: stateDirectory,
    TRUST_PORT: String(runtimePort),
    TRUST_WEB_PORT: String(webPort),
  };
  const remoteEnvironment = { ...environment, TRUST_INSTALL_ROOT: path.join(stateDirectory, "not-an-installation") };
  let server = startCliServer(environment);
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await waitFor(`http://127.0.0.1:${webPort}/health`, server, () => stderr);
    const empty = await runCli(["registry", "list"], remoteEnvironment);
    assert.equal(empty.stdout, "No registry sources configured.\n");

    const added = await runCli(["registry", "add", "local", "http", registryUrl], remoteEnvironment);
    assert.equal(added.stdout, "Registry source local saved.\n");
    const listed = await runCli(["registry", "list"], remoteEnvironment);
    assert.equal(listed.stdout, `local\thttp\t${registryUrl}\n`);
    const synchronized = await runCli(["registry", "sync", "local"], remoteEnvironment);
    assert.equal(synchronized.stdout, "Registry source local synchronized: 2 imported, 0 unchanged.\n");
    await stopCliServer(server);
    server = startCliServer(environment);
    stderr = "";
    server.stderr.setEncoding("utf8");
    server.stderr.on("data", (chunk: string) => { stderr += chunk; });
    await waitFor(`http://127.0.0.1:${webPort}/health`, server, () => stderr);
    const replayed = await runCli(["registry", "sync", "local"], remoteEnvironment);
    assert.equal(replayed.stdout, "Registry source local synchronized: 0 imported, 2 unchanged.\n");
    const removed = await runCli(["registry", "remove", "local"], remoteEnvironment);
    assert.equal(removed.stdout, "Registry source local removed.\n");
    const gitUrl = path.join(stateDirectory, "registry.git");
    const gitAdded = await runCli([
      "registry", "add", "git-release", "git", gitUrl, "--ref", "release",
    ], remoteEnvironment);
    assert.equal(gitAdded.stdout, "Registry source git-release saved.\n");
    const gitListed = await runCli(["registry", "list"], remoteEnvironment);
    assert.equal(gitListed.stdout, `git-release\tgit\t${gitUrl} (ref: release)\n`);
    const gitRemoved = await runCli(["registry", "remove", "git-release"], remoteEnvironment);
    assert.equal(gitRemoved.stdout, "Registry source git-release removed.\n");
  } finally {
    await stopCliServer(server);
    await new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("trust server status does not reuse an unrelated healthy HTTP service", async () => {
  const webPort = await availablePort();
  const unrelated = createHttpServer((request, response) => {
    response.setHeader("content-type", request.url === "/health" ? "application/json" : "text/html");
    response.end(request.url === "/health"
      ? JSON.stringify({ status: "ok", service: "another-service" })
      : "<title>Another service</title>");
  });
  await new Promise<void>((resolve, reject) => {
    unrelated.once("error", reject);
    unrelated.listen(webPort, "127.0.0.1", resolve);
  });
  try {
    await assert.rejects(
      runCli(["server", "status"], { ...process.env, TRUST_WEB_PORT: String(webPort) }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match((error as { stdout?: string }).stdout ?? "", /TRUST server: stopped/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => unrelated.close((error) => error ? reject(error) : resolve()));
  }
});

test("trust registry rejects a malformed JSON-RPC success response", async () => {
  const server = createHttpServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: { sources: [] } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    await assert.rejects(
      runCli(["registry", "list"], { ...process.env, TRUST_URL: `http://127.0.0.1:${address.port}` }),
      /invalid JSON-RPC response/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function startCliServer(environment: NodeJS.ProcessEnv) {
  return spawn(process.execPath, [trustCli, "server", "start"], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function stopCliServer(server: ReturnType<typeof startCliServer>): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server.once("exit", () => resolve()));
}

function runCli(arguments_: readonly string[], environment: NodeJS.ProcessEnv) {
  return execute(process.execPath, [trustCli, ...arguments_], {
    cwd: repositoryRoot,
    env: environment,
    timeout: 10_000,
  });
}

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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(url: string, child: ReturnType<typeof spawn>, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`TRUST shell exited during acceptance startup\n${stderr()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}\n${stderr()}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
