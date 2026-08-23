#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, truncate } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { publicRpc } from "./lib/public-rpc.mjs";
import { assertSqliteSchemaFile } from "../../../packages/trust-runtime/src/database/sqlite-schema.ts";

const environmentRoot = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const stateDirectory = parseStateDirectory(
  process.env.TRUST_SERVER_STATE_DIRECTORY ?? ".trust/server",
);
const database = resolve(stateDirectory, "runtime.sqlite");
const runtimeLog = resolve(stateDirectory, "runtime.log");
const runnerLog = resolve(stateDirectory, "runner.log");
const operations = resolve(root, "assets/operations");
// An Environment's workspaceRoot is the directory that holds the projects; the Check's "project" Input picks one.
const workspaceRoot = resolve(root, "..");
const paymentRoot = resolve(
  process.env.TRUST_PROJECTS_ROOT ?? resolve(environmentRoot, "projects"),
);
// The ignored payment repositories belong to this environment; otherwise the parent directory stands in.
const projectsRoot = existsSync(paymentRoot) ? paymentRoot : undefined;
// `trust-test` combines the payment projects, Kind cluster, jira-mock and Tempo behind the ingress.
const environmentValues = {
  local: { workspaceRoot },
  "trust-test": {
    workspaceRoot: projectsRoot ?? workspaceRoot,
    jiraIssueUrl: "http://jira.127.0.0.1.nip.io/rest/api/3/issue/",
    traceUrl: "http://tempo.127.0.0.1.nip.io/api/traces/",
  },
  ...(projectsRoot ? { payment: { workspaceRoot: projectsRoot } } : {}),
};
const port = parsePort(process.env.TRUST_SERVER_PORT ?? "4318");
const webPort = parsePort(process.env.TRUST_WEB_PORT ?? "4173");
const endpoint = `http://127.0.0.1:${port}`;
const webEndpoint = `http://127.0.0.1:${webPort}`;
const rpcEndpoint = `${endpoint}/rpc`;
const mcpEndpoint = `${endpoint}/mcp`;
const tmux = Object.freeze({
  backend: Object.freeze({
    session: parseTmuxSession(process.env.TRUST_SERVER_TMUX_SESSION ?? "trust-backend"),
    window: "backend",
  }),
  frontend: Object.freeze({
    session: parseTmuxSession(process.env.TRUST_WEB_TMUX_SESSION ?? "trust-frontend"),
    window: "frontend",
  }),
});
if (tmux.backend.session === tmux.frontend.session) {
  throw new TypeError("TRUST_SERVER_TMUX_SESSION and TRUST_WEB_TMUX_SESSION must be different");
}
const command = process.argv[2];
const withWeb = process.argv.includes("--web");

switch (command) {
  case "start":
    await start(false, withWeb);
    break;
  case "reset":
    await start(true, withWeb);
    await seed();
    break;
  case "seed":
    await seed();
    break;
  case "preflight":
    await preflight(parsePreflight(process.argv.slice(3)));
    break;
  case "logs":
    if (process.argv[3] !== "clear" || process.argv.length !== 4) {
      throw new TypeError("usage: server.ts logs clear");
    }
    await clearLogs();
    break;
  default:
    throw new TypeError(
      "usage: server.ts start [--web] | reset [--web] | seed | logs clear | preflight --ticket <key> --procedure <slug> --version <version>",
    );
}

async function start(reset: boolean, startWeb: boolean) {
  if (!reset) assertSqliteSchemaFile(database);

  const sessionExists = await hasBackendSession();
  let activeInstance: string | undefined;
  if (await healthy()) {
    if (!sessionExists) throw portOwnerError(port, "runtime");
    activeInstance = await sessionInstance();
    if (!activeInstance || !await healthy(activeInstance)) {
      await stopBackend();
      if (await healthy()) throw portOwnerError(port, "runtime");
      activeInstance = undefined;
    } else if (reset) {
      await stopBackend();
      activeInstance = undefined;
    } else {
      await assertBackend(activeInstance);
    }
  } else if (sessionExists) {
    await stopBackend();
  }

  let backendStarted = false;
  if (activeInstance === undefined) {
    await waitForAvailablePort(port, "runtime");
    if (reset) {
      for (const suffix of ["", "-wal", "-shm", ".trust-process-lock"]) {
        await rm(`${database}${suffix}`, { force: true });
      }
    }
    await run(["npm", "run", "build", "--workspace=@trust/runtime"], "ignore");
    activeInstance = randomUUID();
    try {
      await createTmuxSession(tmux.backend, [
        "-e", `TRUST_DATABASE_PATH=${database}`,
        "-e", `TRUST_OPERATIONS_DIRECTORY=${operations}`,
        "-e", "TRUST_HOST=127.0.0.1",
        "-e", `TRUST_PORT=${port}`,
        "-e", `TRUST_RUNTIME_INSTANCE=${activeInstance}`,
        "-e", `TRUST_RUNTIME_LOG_PATH=${runtimeLog}`,
        "-e", `TRUST_SEMANTIC_AUTHORITY=trust-test:${port}`,
        ...(process.env.TRUST_LOG_LEVEL
          ? ["-e", `TRUST_LOG_LEVEL=${process.env.TRUST_LOG_LEVEL}`]
          : []),
      ], "exec npm start");
      backendStarted = true;
      await waitForHealth(activeInstance);
      await assertBackend(activeInstance);
    } catch (error) {
      await stopBackend().catch(() => undefined);
      throw error;
    }
  }

  if (startWeb) await ensureFrontend(activeInstance);
  process.stdout.write(backendStarted
    ? `TRUST server: started${reset ? " with an empty database" : ""}\n`
    : "TRUST server: already available\n");
  process.stdout.write(`TRUST runtime log: ${runtimeLog}\n`);
  process.stdout.write(`TRUST runner log: ${runnerLog}\n`);
}

async function ensureFrontend(instance: string) {
  if (await hasFrontendSession()) {
    if (await webHealthy(instance) && await frontendCommandIsValid()) return;
    await stopFrontend();
  }
  await waitForAvailablePort(webPort, "web");
  try {
    await createTmuxSession(tmux.frontend, [
      "-e", `TRUST_RUNTIME_URL=${endpoint}`,
      "-e", `TRUST_WEB_PORT=${webPort}`,
    ], "exec npm run dev:web");
    await waitForWeb(instance);
    await assertFrontend();
  } catch (error) {
    await stopFrontend().catch(() => undefined);
    throw error;
  }
}

async function stopBackend() {
  if (await hasBackendSession()) {
    await run(["tmux", "kill-session", "-t", tmux.backend.session], "ignore");
  }
}

async function stopFrontend() {
  if (await hasFrontendSession()) {
    await run(["tmux", "kill-session", "-t", tmux.frontend.session], "ignore");
  }
}

async function seed() {
  await requireHealth();
  for (const [environment, values] of Object.entries(environmentValues)) {
    await publicRpc(rpcEndpoint, "environment.save", { environment, values });
  }
  const procedureDirectory = resolve(root, "assets/procedures");
  const names = (await readdir(procedureDirectory)).filter((name) => name.endsWith(".feature")).sort();
  const procedures = [];
  for (const name of names) {
    const publication = await publicRpc(rpcEndpoint, "procedure.publish", {
      source: await readFile(resolve(procedureDirectory, name), "utf8"),
      sourceName: name,
    });
    procedures.push(`${publication.procedure.procedure}@${publication.procedure.version}`);
  }
  process.stdout.write(`TRUST seed: ${procedures.join(", ")}\n`);
}

async function clearLogs() {
  await Promise.all([clearLog(runtimeLog), clearLog(runnerLog)]);
  process.stdout.write(`TRUST logs: cleared ${runtimeLog} and ${runnerLog}\n`);
}

async function clearLog(logPath: string) {
  try {
    await truncate(logPath, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function preflight(options: { ticket: string; procedure: string; version: string }) {
  await requireHealth();
  await assertBackend();
  const published = await publicRpc(rpcEndpoint, "procedure.read", {
    procedure: options.procedure,
    version: options.version,
  });
  if (
    published?.procedure?.procedure !== options.procedure
    || published?.procedure?.version !== options.version
  ) {
    throw new Error(`published procedure mismatch: ${options.procedure}@${options.version}`);
  }

  const response = await fetch(mcpEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (!response.ok) throw new Error(`MCP tools/list failed with HTTP ${response.status}`);
  const payload = await response.json() as { result?: { tools?: Array<{ name?: string }> } };
  const tools = new Set(payload.result?.tools?.map(({ name }) => name) ?? []);
  for (const name of [
    "trust_procedure_read",
    "trust_plan_read",
    "trust_session_read",
    "trust_check_read",
    "trust_plan_engage",
    "trust_plan_declarations_replace",
  ]) {
    if (!tools.has(name)) throw new Error(`MCP tool missing: ${name}`);
  }

  const smokePlan = ["preflight", options.ticket.toLowerCase(), Date.now().toString(36)].join("-");
  await mcpTool("trust_plan_engage", {
    procedure: options.procedure,
    procedureVersion: options.version,
    plan: smokePlan,
    environment: "trust-test",
    rootInputs: { "jira issue": options.ticket },
  });
  process.stdout.write(`TRUST preflight: ${options.procedure}@${options.version} published\n`);
  process.stdout.write("TRUST preflight: MCP read/write tools available\n");
  process.stdout.write(`TRUST preflight: Plan ${smokePlan} engaged\n`);
}

async function mcpTool(name: string, arguments_: Record<string, unknown>) {
  const response = await fetch(mcpEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  });
  if (!response.ok) throw new Error(`MCP ${name} failed with HTTP ${response.status}`);
  const payload = await response.json() as {
    error?: { message?: string };
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  };
  const text = payload.result?.content?.find(({ type }) => type === "text")?.text;
  if (payload.error !== undefined || payload.result?.isError === true || text === undefined) {
    throw new Error(payload.error?.message ?? text ?? `MCP ${name} returned no text`);
  }
  return text;
}

async function assertBackend(expectedInstance?: string) {
  if (!await hasBackendSession()) throw new Error("the TRUST backend session is not running");
  for (const [name, expected] of [
    ["TRUST_DATABASE_PATH", database],
    ["TRUST_OPERATIONS_DIRECTORY", operations],
    ["TRUST_PORT", String(port)],
    ["TRUST_RUNTIME_LOG_PATH", runtimeLog],
    ["TRUST_SEMANTIC_AUTHORITY", `trust-test:${port}`],
    ...(expectedInstance ? [["TRUST_RUNTIME_INSTANCE", expectedInstance]] as const : []),
  ] as readonly (readonly [string, string])[]) {
    const output = await capture(["tmux", "show-environment", "-t", tmux.backend.session, name]);
    if (output.trim() !== `${name}=${expected}`) {
      throw new Error(`the active runtime does not use the fixed ${name}`);
    }
  }
  const started = await paneStartCommand(tmux.backend);
  if (!started.includes("npm start")) throw new Error("the TRUST backend is not running the compiled runtime");
}

async function assertFrontend() {
  if (!await hasFrontendSession()) throw new Error("the TRUST frontend session is not running");
  for (const [name, expected] of [
    ["TRUST_RUNTIME_URL", endpoint],
    ["TRUST_WEB_PORT", String(webPort)],
  ] as const) {
    const output = await capture(["tmux", "show-environment", "-t", tmux.frontend.session, name]);
    if (output.trim() !== `${name}=${expected}`) {
      throw new Error(`the active frontend does not use the fixed ${name}`);
    }
  }
  if (!await frontendCommandIsValid()) throw new Error("the TRUST frontend is not running with live reload");
}

async function frontendCommandIsValid() {
  return (await paneStartCommand(tmux.frontend)).includes("npm run dev:web");
}

async function paneStartCommand(target: { session: string; window: string }) {
  return capture(["tmux", "display-message", "-p", "-t", `${target.session}:${target.window}`, "#{pane_start_command}"]);
}

async function createTmuxSession(
  target: { session: string; window: string },
  environment: string[],
  command: string,
) {
  await run([
    "tmux", "new-session", "-d", "-s", target.session, "-n", target.window,
    "-c", root,
    ...environment,
  ], "ignore");
  await run(["tmux", "set-option", "-t", target.session, "remain-on-exit", "on"], "ignore");
  await run([
    "tmux", "respawn-pane", "-k", "-t", `${target.session}:${target.window}`,
    "-c", root,
    command,
  ], "ignore");
}

async function waitForHealth(instance: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await healthy(instance)) return;
    await assertPaneAlive(tmux.backend, "backend");
    await delay(250);
  }
  throw new Error("TRUST server did not become healthy within 120 seconds");
}

async function waitForWeb(instance: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await webHealthy(instance)) return;
    await assertPaneAlive(tmux.frontend, "frontend");
    await delay(250);
  }
  throw new Error(`TRUST web did not become healthy on 127.0.0.1:${webPort} within 120 seconds`);
}

async function assertPaneAlive(target: { session: string; window: string }, service: string) {
  if (!await hasTmuxSession(target.session)) {
    throw new Error(`TRUST ${service} tmux session '${target.session}' exited during startup`);
  }
  const dead = await capture([
    "tmux", "display-message", "-p", "-t", `${target.session}:${target.window}`, "#{pane_dead}",
  ]);
  if (dead.trim() !== "1") return;
  const output = await capture([
    "tmux", "capture-pane", "-p", "-t", `${target.session}:${target.window}`, "-S", "-200",
  ]);
  throw new Error(`TRUST ${service} exited during startup\n${output.trim()}`);
}

async function requireHealth() {
  const instance = await sessionInstance();
  if (!instance || !await healthy(instance)) {
    throw new Error(`TRUST server is unavailable or is not owned by tmux session '${tmux.backend.session}'`);
  }
}

async function healthy(instance?: string) {
  try {
    const response = await fetch(`${endpoint}/health`);
    return response.ok && (!instance || response.headers.get("x-trust-runtime-instance") === instance);
  } catch {
    return false;
  }
}

async function webHealthy(instance?: string) {
  try {
    const [page, proxy] = await Promise.all([
      fetch(webEndpoint),
      fetch(`${webEndpoint}/health`),
    ]);
    return page.ok
      && proxy.ok
      && (!instance || proxy.headers.get("x-trust-runtime-instance") === instance);
  } catch {
    return false;
  }
}

async function hasBackendSession() {
  return hasTmuxSession(tmux.backend.session);
}

async function hasFrontendSession() {
  return hasTmuxSession(tmux.frontend.session);
}

async function hasTmuxSession(session: string) {
  return await exitCode(["tmux", "has-session", "-t", session]) === 0;
}

async function sessionInstance(): Promise<string | undefined> {
  if (!await hasBackendSession()) return undefined;
  try {
    const output = await capture(["tmux", "show-environment", "-t", tmux.backend.session, "TRUST_RUNTIME_INSTANCE"]);
    const prefix = "TRUST_RUNTIME_INSTANCE=";
    const value = output.trim();
    return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
  } catch {
    return undefined;
  }
}

async function waitForAvailablePort(value: number, service: "runtime" | "web"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await portAvailable(value)) return;
    await delay(100);
  }
  throw portOwnerError(value, service);
}

function portAvailable(value: number): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const server = createNetServer();
    server.unref();
    server.once("error", () => resolveAvailability(false));
    server.listen(value, "127.0.0.1", () => {
      server.close(() => resolveAvailability(true));
    });
  });
}

function portOwnerError(value: number, service: "runtime" | "web"): Error {
  const session = service === "runtime" ? tmux.backend.session : tmux.frontend.session;
  return new Error(`TRUST ${service} port ${value} is already owned outside tmux session '${session}'`);
}

async function run(argv: string[], stdio: "inherit" | "ignore" = "inherit") {
  const code = await childExit(argv, stdio);
  if (code !== 0) throw new Error(`${argv[0]} failed with exit ${code}`);
}

async function capture(argv: string[]) {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await exit(child);
  if (code !== 0) throw new Error(stderr.trim() || `${argv[0]} failed with exit ${code}`);
  return stdout;
}

async function exitCode(argv: string[]) {
  return childExit(argv, "ignore");
}

function childExit(argv: string[], stdio: "inherit" | "ignore"): Promise<number> {
  return exit(spawn(argv[0]!, argv.slice(1), {
    cwd: root,
    env: process.env,
    stdio,
  }));
}

function exit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === null ? 1 : 128)));
  });
}

function parsePreflight(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new TypeError("invalid preflight arguments");
    values.set(name.slice(2), value);
  }
  return {
    ticket: requiredValue(values.get("ticket"), "ticket"),
    procedure: requiredValue(values.get("procedure"), "procedure"),
    version: requiredValue(values.get("version"), "version"),
  };
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError(`TRUST_SERVER_PORT must be an integer between 1 and 65535, received '${value}'`);
  }
  return parsed;
}

function parseTmuxSession(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new TypeError("TRUST_SERVER_TMUX_SESSION must contain only letters, numbers, '_' or '-'");
  }
  return value;
}

function parseStateDirectory(value: string): string {
  const resolved = resolve(root, value);
  if (resolved === root || resolved === parse(resolved).root) {
    throw new TypeError("TRUST_SERVER_STATE_DIRECTORY must not be the repository or filesystem root");
  }
  return resolved;
}

function requiredValue(value: string | undefined, name: string) {
  if (value === undefined || value === "" || value.includes("\0")) throw new TypeError(`${name} is required`);
  return value;
}
