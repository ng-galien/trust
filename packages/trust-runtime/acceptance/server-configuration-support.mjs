import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export const root = path.resolve(import.meta.dirname, "../../..");
export const cli = path.join(root, "packages/trust-shell/bin/trust.js");
export function cleanEnvironment(extra = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TRUST_"))),
    ...extra,
  };
}
export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function command(args, env = {}, entry = cli) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: root,
    env: cleanEnvironment(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const [code] = await once(child, "exit");
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
export async function setupConfiguration(input = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-configuration-"));
  const port = await freePort(),
    webPort = await freePort();
  const file = path.join(directory, "configuration.json");
  const configuration = {
    server: { host: "127.0.0.1", port, webPort, stateDirectory: path.join(directory, "state"), ...input.server },
    storage: { kind: "pglite", directory: path.join(directory, "pglite") },
    ...input,
  };
  configuration.server = {
    host: "127.0.0.1",
    port,
    webPort,
    stateDirectory: path.join(directory, "state"),
    ...input.server,
  };
  await writeFile(file, JSON.stringify(configuration));
  let current;
  return {
    directory,
    file,
    configuration,
    port: configuration.server.port,
    webPort: configuration.server.webPort,
    async start(extra = {}) {
      assert.equal(current, undefined);
      current = await startServer(file, extra);
      return current;
    },
    async stop() {
      await current?.close();
      current = undefined;
    },
    async close() {
      await this.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function startServer(file, extra = {}) {
  const processHandle = spawn(process.execPath, [cli, "server", "start"], {
    cwd: root,
    env: cleanEnvironment({ TRUST_CONFIG_FILE: file, ...extra }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  processHandle.stdout.on("data", (c) => (output += c));
  processHandle.stderr.on("data", (c) => (output += c));
  const close = async () => {
    if (processHandle.exitCode === null && processHandle.signalCode === null) {
      const exit = once(processHandle, "exit");
      processHandle.kill("SIGTERM");
      await exit;
    }
  };
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const url = output.match(/TRUST server: running at (http:\/\/[^\s]+)/)?.[1];
    if (url) return { endpoint: url, output: () => output, close };
    if (processHandle.exitCode !== null || processHandle.signalCode !== null)
      throw new Error(`Server startup failed: ${output}`);
    await delay(25);
  }
  await close();
  throw new Error(`Server startup timed out: ${output}`);
}
export async function configuredRuntime(options) {
  const fixture = await setupConfiguration({
    server: {
      semanticAuthority: "configured.example:443",
      operationsDirectory: options.operationsDirectory,
      extensionsFile: options.extensionsFile,
    },
    storage: options.storage,
    authentication: {
      profile: "development",
      access: options.accessConfiguration,
      resourceUrl: options.accessResourceUrl,
      ...(options.browserAuthentication ? { browser: options.browserAuthentication } : {}),
    },
  });
  try {
    const server = await fixture.start();
    return { host: "127.0.0.1", port: fixture.webPort, close: () => fixture.close(), endpoint: server.endpoint };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
