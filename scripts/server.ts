#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { publicRpc } from "../infra/server/lib/public-rpc.mjs";
import { assertSqliteSchemaFile } from "../packages/trust-runtime/src/database/sqlite-schema.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const stateDirectory = parseStateDirectory(
  process.env.TRUST_SERVER_STATE_DIRECTORY ?? ".trust/server",
);
const database = resolve(stateDirectory, "runtime.sqlite");
const operations = resolve(root, "assets/operations");
// An Environment's workspaceRoot is the directory that holds the projects; the Check's "project" Input picks one.
const workspaceRoot = resolve(root, "..");
const paymentRoot = resolve(process.env.TRUST_PROJECTS_ROOT ?? resolve(root, "../trust-projects"));
// The payment projects live next to this repository when checked out; otherwise the parent directory stands in.
const projectsRoot = existsSync(paymentRoot) ? paymentRoot : undefined;
// `trust-test` is the Kind test environment (k8s/): the payment projects, the jira-mock and Tempo behind the ingress.
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
  session: parseTmuxSession(process.env.TRUST_SERVER_TMUX_SESSION ?? "trust"),
  window: "server",
});
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
  default:
    throw new TypeError(
      "usage: server.ts start [--web] | reset [--web] | seed | preflight --ticket <key> --procedure <slug> --version <version>",
    );
}

async function start(reset: boolean, startWeb: boolean) {
  if (!reset) assertSqliteSchemaFile(database);
  const sessionExists = await hasSession();
  if (await healthy()) {
    if (!sessionExists) throw portOwnerError(port, "runtime");
    const activeInstance = await sessionInstance();
    if (!activeInstance || !await healthy(activeInstance)) {
      await stop();
      if (await healthy()) throw portOwnerError(port, "runtime");
    } else if (reset) await stop();
    else if (!startWeb || await developmentStackHealthy(activeInstance)) {
      await assertServer(startWeb, activeInstance);
      process.stdout.write("TRUST server: already available\n");
      return;
    } else await stop();
  } else if (sessionExists) {
    await stop();
  }

  await waitForAvailablePort(port, "runtime");
  if (startWeb) await waitForAvailablePort(webPort, "web");
  if (reset) {
    for (const suffix of ["", "-wal", "-shm", ".trust-process-lock"]) {
      await rm(`${database}${suffix}`, { force: true });
    }
  }
  const instance = randomUUID();
  let sessionCreated = false;
  try {
    await run([
      "tmux", "new-session", "-d", "-s", tmux.session, "-n", tmux.window,
      "-c", root,
      "-e", `TRUST_DATABASE_PATH=${database}`,
      "-e", `TRUST_OPERATIONS_DIRECTORY=${operations}`,
      "-e", "TRUST_HOST=127.0.0.1",
      "-e", `TRUST_PORT=${port}`,
      "-e", `TRUST_WEB_PORT=${webPort}`,
      "-e", `TRUST_RUNTIME_INSTANCE=${instance}`,
      "-e", `TRUST_SEMANTIC_AUTHORITY=trust-test:${port}`,
      ...(process.env.TRUST_DEV_WATCH_INCLUDE
        ? ["-e", `TRUST_DEV_WATCH_INCLUDE=${process.env.TRUST_DEV_WATCH_INCLUDE}`]
        : []),
      `exec npm run ${startWeb ? "dev:stack" : "dev:server"}`,
    ], "ignore");
    sessionCreated = true;
    await run(["tmux", "set-option", "-t", tmux.session, "remain-on-exit", "on"], "ignore");
    await waitForHealth(instance);
    if (startWeb) await waitForWeb(instance);
    await assertServer(startWeb, instance);
    process.stdout.write(`TRUST server: started${reset ? " with an empty database" : ""}\n`);
  } catch (error) {
    if (sessionCreated) await stop().catch(() => undefined);
    throw error;
  }
}

async function stop() {
  if (await hasSession()) {
    await run(["tmux", "kill-session", "-t", tmux.session], "ignore");
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

async function preflight(options: { ticket: string; procedure: string; version: string }) {
  await requireHealth();
  await assertServer();
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

async function assertServer(expectWeb = false, expectedInstance?: string) {
  if (!await hasSession()) throw new Error("the TRUST server session is not running");
  for (const [name, expected] of [
    ["TRUST_DATABASE_PATH", database],
    ["TRUST_OPERATIONS_DIRECTORY", operations],
    ["TRUST_PORT", String(port)],
    ["TRUST_SEMANTIC_AUTHORITY", `trust-test:${port}`],
    ...(expectedInstance ? [["TRUST_RUNTIME_INSTANCE", expectedInstance]] as const : []),
    ...(expectWeb ? [["TRUST_WEB_PORT", String(webPort)]] as const : []),
  ] as readonly (readonly [string, string])[]) {
    const output = await capture(["tmux", "show-environment", "-t", tmux.session, name]);
    if (output.trim() !== `${name}=${expected}`) {
      throw new Error(`the active runtime does not use the fixed ${name}`);
    }
  }
}

async function developmentStackHealthy(instance: string) {
  if (!await webHealthy(instance)) return false;
  const started = await capture(["tmux", "display-message", "-p", "-t", `${tmux.session}:${tmux.window}`, "#{pane_start_command}"]);
  return started.includes("npm run dev:stack");
}

async function waitForHealth(instance: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await healthy(instance)) return;
    await delay(250);
  }
  throw new Error("TRUST server did not become healthy within 120 seconds");
}

async function waitForWeb(instance: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await webHealthy(instance)) return;
    await delay(250);
  }
  throw new Error(`TRUST web did not become healthy on 127.0.0.1:${webPort} within 120 seconds`);
}

async function requireHealth() {
  const instance = await sessionInstance();
  if (!instance || !await healthy(instance)) {
    throw new Error(`TRUST server is unavailable or is not owned by tmux session '${tmux.session}'`);
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

async function hasSession() {
  return await exitCode(["tmux", "has-session", "-t", tmux.session]) === 0;
}

async function sessionInstance(): Promise<string | undefined> {
  if (!await hasSession()) return undefined;
  try {
    const output = await capture(["tmux", "show-environment", "-t", tmux.session, "TRUST_RUNTIME_INSTANCE"]);
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
  return new Error(`TRUST ${service} port ${value} is already owned outside tmux session '${tmux.session}'`);
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
