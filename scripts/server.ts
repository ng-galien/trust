#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { publicRpc } from "../infra/server/lib/public-rpc.mjs";
import { generateServerRuntimeConfig } from "../infra/server/generate-runtime-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const stateDirectory = resolve(root, ".trust/server");
const generated = resolve(stateDirectory, "generated");
const database = resolve(stateDirectory, "runtime.sqlite");
const operations = resolve(root, "assets/operations");
const executionEnvironments = JSON.stringify({
  local: { projectRoot: root },
  "trust-test": { projectRoot: root },
});
const endpoint = "http://127.0.0.1:4318";
const rpcEndpoint = `${endpoint}/rpc`;
const mcpEndpoint = `${endpoint}/mcp`;
const tmux = Object.freeze({ session: "trust", window: "server" });
const skillPolicy = parseSkillPolicy(process.env.TRUST_SKILL_POLICY);
const command = process.argv[2];

switch (command) {
  case "start":
    await start(false);
    break;
  case "reset":
    await start(true);
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
      "usage: server.ts start | reset | seed | preflight --ticket <key> --procedure <slug> --version <version>",
    );
}

async function start(reset: boolean) {
  if (await healthy()) {
    if (reset) await stop();
    else {
      await assertServer();
      process.stdout.write("TRUST server: already available\n");
      return;
    }
  } else if (await hasSession()) {
    await stop();
  }

  if (reset) {
    for (const suffix of ["", "-wal", "-shm", ".trust-process-lock"]) {
      await rm(`${database}${suffix}`, { force: true });
    }
  }
  if (skillPolicy === "verified") {
    await generateServerRuntimeConfig({ outputDirectory: generated, environment: process.env });
  }
  await run([
    "tmux", "new-session", "-d", "-s", tmux.session, "-n", tmux.window,
    "-c", root,
    "-e", `TRUST_SKILL_POLICY=${skillPolicy}`,
    ...(skillPolicy === "verified" ? ["-e", `TRUST_CONFIG_DIRECTORY=${generated}`] : []),
    "-e", `TRUST_DATABASE_PATH=${database}`,
    "-e", `TRUST_EXECUTIONS_DIRECTORY=${operations}`,
    "-e", `TRUST_EXECUTION_ENVIRONMENTS_JSON=${executionEnvironments}`,
    "-e", "TRUST_HOST=127.0.0.1",
    "-e", "TRUST_PORT=4318",
    "-e", "TRUST_SEMANTIC_AUTHORITY=trust-test:4318",
    "exec node infra/server/start-runtime.mjs --dev",
  ]);
  await run(["tmux", "set-option", "-t", tmux.session, "remain-on-exit", "on"]);
  await waitForHealth();
  await assertServer();
  process.stdout.write(`TRUST server: started${reset ? " with an empty database" : ""}\n`);
}

async function stop() {
  if (await hasSession()) {
    await run(["tmux", "kill-session", "-t", tmux.session]);
  }
}

async function seed() {
  await requireHealth();
  const publisherToken = policyCredential("TRUST_PUBLISHER_TOKEN");
  const procedureDirectory = resolve(root, "assets/procedures");
  const names = (await readdir(procedureDirectory)).filter((name) => name.endsWith(".feature")).sort();
  const procedures = [];
  for (const name of names) {
    const publication = await publicRpc(rpcEndpoint, "procedure.definition.publish", {
      source: await readFile(resolve(procedureDirectory, name), "utf8"),
      sourceName: name,
    }, publisherToken);
    procedures.push(`${publication.definition.procedure}@${publication.definition.version}`);
  }
  process.stdout.write(`TRUST seed: ${procedures.join(", ")}\n`);
}

async function preflight(options: { ticket: string; procedure: string; version: string }) {
  await requireHealth();
  await assertServer();
  if (skillPolicy === "verified") {
    await assertCredential("TRUST_SKILL_RUNTIME_IDENTITY", "TRUST_RUNTIME_CREDENTIAL");
    await assertCredential("TRUST_SKILL_PROCESS_IDENTITY", "TRUST_RUNTIME_PROCESS_CREDENTIAL");
  }

  const definition = await publicRpc(rpcEndpoint, "procedure.definition.read", {
    procedure: options.procedure,
    version: options.version,
  }, policyCredential("TRUST_PUBLISHER_TOKEN"));
  if (
    definition?.definition?.procedure !== options.procedure
    || definition?.definition?.version !== options.version
  ) {
    throw new Error(`published procedure mismatch: ${options.procedure}@${options.version}`);
  }

  const response = await fetch(mcpEndpoint, {
    method: "POST",
    headers: {
      ...authorizationHeader("TRUST_OPERATOR_TOKEN"),
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
      ...authorizationHeader("TRUST_OPERATOR_TOKEN"),
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

async function assertCredential(identityName: string, credentialName: string) {
  const identity = required(identityName);
  const credential = required(credentialName);
  const principals = JSON.parse(await readFile(resolve(generated, "registry-principals.json"), "utf8"));
  const digest = `sha256:${createHash("sha256").update(credential).digest("hex")}`;
  if (!Array.isArray(principals) || !principals.some((principal) => (
    principal?.identity === identity && principal?.credentialSha256 === digest
  ))) {
    throw new Error(`${credentialName} does not match the active runtime principal`);
  }
}

async function assertServer() {
  if (!await hasSession()) throw new Error("the TRUST server session is not running");
  for (const [name, expected] of [
    ["TRUST_SKILL_POLICY", skillPolicy],
    ...(skillPolicy === "verified" ? [["TRUST_CONFIG_DIRECTORY", generated]] : []),
    ["TRUST_DATABASE_PATH", database],
    ["TRUST_EXECUTIONS_DIRECTORY", operations],
    ["TRUST_EXECUTION_ENVIRONMENTS_JSON", executionEnvironments],
  ] as readonly (readonly [string, string])[]) {
    const output = await capture(["tmux", "show-environment", "-t", tmux.session, name]);
    if (output.trim() !== `${name}=${expected}`) {
      throw new Error(`the active runtime does not use the fixed ${name}`);
    }
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await Bun.sleep(250);
  }
  throw new Error("TRUST server did not become healthy within 120 seconds");
}

async function requireHealth() {
  if (!await healthy()) throw new Error("TRUST server is unavailable on 127.0.0.1:4318");
}

async function healthy() {
  try {
    const response = await fetch(`${endpoint}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function hasSession() {
  return await exitCode(["tmux", "has-session", "-t", tmux.session]) === 0;
}

async function run(argv: string[]) {
  const child = Bun.spawn(argv, { cwd: root, env: process.env, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${argv[0]} failed with exit ${code}`);
}

async function capture(argv: string[]) {
  const child = Bun.spawn(argv, { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `${argv[0]} failed with exit ${code}`);
  return stdout;
}

async function exitCode(argv: string[]) {
  return await Bun.spawn(argv, { cwd: root, env: process.env, stdout: "ignore", stderr: "ignore" }).exited;
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

function required(name: string) {
  return requiredValue(process.env[name], name);
}

function policyCredential(name: string): string | undefined {
  return skillPolicy === "verified" ? required(name) : undefined;
}

function authorizationHeader(name: string): Record<string, string> {
  const credential = policyCredential(name);
  return credential === undefined ? {} : { Authorization: `Bearer ${credential}` };
}

function parseSkillPolicy(value: string | undefined): "local" | "verified" {
  if (value === undefined || value === "" || value === "local") return "local";
  if (value === "verified") return "verified";
  throw new TypeError(`TRUST_SKILL_POLICY must be 'local' or 'verified', received '${value}'`);
}

function requiredValue(value: string | undefined, name: string) {
  if (value === undefined || value === "" || value.includes("\0")) throw new TypeError(`${name} is required`);
  return value;
}
