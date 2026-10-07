import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { parse as parseToml } from "smol-toml";

import {
  assertBuiltCheckout,
  createIsolatedWorkspace,
  freePorts,
  npm,
  PACKAGE_NAME,
  packTrustPackage,
  repositoryRoot,
  run as runIn,
} from "./package-support.mjs";

const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const RUNNER_FILES = ["SKILL.md", "references/results.md", "scripts/run.js", "scripts/auth.js", "scripts/trial.js"];

let workspace;
let environment;
let packed;
let installed;
let trustBin;
let dataDirectory;
let webPort;
let runtimePort;
let server;
let serverOutput = "";
let serverUrl;

function run(command, arguments_, options = {}) {
  return runIn(environment, command, arguments_, options);
}

async function trust(arguments_, cwd) {
  return run(process.execPath, [trustBin, ...arguments_], { cwd });
}

async function rpc(method, params) {
  const response = await fetch(`${serverUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}

async function mcp(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}

/** Runs the project's deployed Runner with one unknown Check URI: TRUST itself must answer. */
async function probeRunner(runnerDirectory, endpoints, cwd) {
  const { stdout } = await run(
    process.execPath,
    [
      path.join(runnerDirectory, "scripts/run.js"),
      `trust://127.0.0.1:${runtimePort}/absent@1.0.0/plan/scenario/check/op`,
      "--json",
    ],
    { cwd, env: { ...environment, ...endpoints } },
  );
  const result = JSON.parse(stdout).result;
  assert.equal(result.status, "REFUSED", stdout);
  assert.equal(result.reasonCode, "check-not-found", stdout);
}

async function filesUnder(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(files, await filesUnder(root, child));
    else files[child] = await readFile(path.join(root, child));
  }
  return files;
}

async function newProject(name) {
  const project = path.join(workspace, "projects", name);
  await mkdir(project, { recursive: true });
  return project;
}

function tomlTables(source) {
  return source.split("\n").filter((line) => /^\s*\[/.test(line));
}

/** TOML tables as plain JSON data (the parser creates prototype-less objects). */
function tomlData(source) {
  return JSON.parse(JSON.stringify(parseToml(source)));
}

/** Reads one value through a TOML 1.0 parser, which also proves the whole file is valid TOML. */
function tomlValue(source, table, key) {
  const node = table.split(".").reduce((parent, part) => parent?.[part], parseToml(source));
  assert.ok(node && Object.hasOwn(node, key), `${table}.${key} missing`);
  return node[key];
}

function assertSubsequence(lines, expected, label) {
  let index = 0;
  for (const line of lines) if (line === expected[index]) index++;
  assert.equal(index, expected.length, `${label}: original lines were lost or reordered`);
}

before(async () => {
  assertBuiltCheckout();
  ({ workspace, environment } = await createIsolatedWorkspace("trust-npm-package-"));
  let archive;
  ({ packed, archive } = await packTrustPackage(workspace, environment));

  const consumer = path.join(workspace, "consumer");
  await mkdir(consumer);
  assert.deepEqual(await readdir(consumer), []);
  await npm(environment, ["install", "--prefix", consumer, "--offline", "--no-audit", "--no-fund", archive], consumer);
  installed = path.join(consumer, "node_modules", PACKAGE_NAME);
  trustBin = path.join(consumer, "node_modules/.bin/trust");

  [webPort, runtimePort] = await freePorts(2);
  dataDirectory = path.join(workspace, "data");
  serverUrl = `http://127.0.0.1:${webPort}`;
  const elsewhere = path.join(workspace, "elsewhere");
  await mkdir(elsewhere);
  server = spawn(
    process.execPath,
    [trustBin, "start", "--port", String(webPort), "--runtime-port", String(runtimePort), "--data-dir", dataDirectory],
    { cwd: elsewhere, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.setEncoding("utf8").on("data", (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.setEncoding("utf8").on("data", (chunk) => {
    serverOutput += chunk;
  });
  const deadline = Date.now() + 45_000;
  while (!serverOutput.includes("Connect a project:")) {
    if (server.exitCode !== null) assert.fail(`trust start exited: ${serverOutput}`);
    if (Date.now() > deadline) assert.fail(`trust start did not report its addresses: ${serverOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const exited = once(server, "exit");
    const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

test("DIST-010 AC1 the packed package installs in an empty directory and trust start serves the interface, RPC and MCP", async () => {
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  const shell = JSON.parse(await readFile(path.join(repositoryRoot, "packages/trust-shell/package.json"), "utf8"));
  assert.equal(manifest.name, PACKAGE_NAME);
  assert.equal(manifest.version, shell.version);
  assert.equal((await trust(["--version"], workspace)).stdout, `${manifest.version}\n`);
  const help = (await trust(["--help"], workspace)).stdout;
  for (const command of ["trust start [--port", "trust setup <project-directory>", "trust server start"])
    assert.ok(help.includes(command), `trust --help lists ${command}`);
  await assert.rejects(trust([], workspace), (error) => {
    assert.equal(error.code, 1);
    assert.ok(error.stderr.startsWith("usage: trust"), `trust without arguments prints the usage: ${error.stderr}`);
    assert.ok(error.stderr.includes("trust setup <project-directory>"));
    return true;
  });

  for (const line of [
    `TRUST server: running at ${serverUrl}`,
    `TRUST interface: ${serverUrl}/`,
    `TRUST RPC: ${serverUrl}/rpc`,
    `TRUST MCP: ${serverUrl}/mcp`,
    `TRUST OTLP: ${serverUrl}/v1/traces`,
    `TRUST runtime: http://127.0.0.1:${runtimePort}`,
    `TRUST data: ${dataDirectory}`,
  ])
    assert.ok(serverOutput.split("\n").includes(line), `missing "${line}" in:\n${serverOutput}`);

  const page = await fetch(`${serverUrl}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>TRUST<\/title>/);
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(script, "the interface references its compiled script");
  assert.equal((await fetch(`${serverUrl}${script}`)).status, 200);
  const health = await (await fetch(`${serverUrl}/health`)).json();
  assert.equal(health.service, "trust-runtime");

  // TRUST carries no Operation: a fresh installation starts with an empty catalogue and authors or imports its own.
  const catalog = await rpc("operation.list", {});
  assert.deepEqual(catalog.operations, []);

  const tools = (await mcp(`${serverUrl}/mcp`, "tools/list", {})).tools.map((tool) => tool.name);
  for (const name of ["trust_plan_read", "trust_documentation_read"]) assert.ok(tools.includes(name), name);
  const skill = await mcp(`${serverUrl}/mcp`, "tools/call", {
    name: "trust_documentation_read",
    arguments: { document: "agents/SKILL" },
  });
  assert.notEqual(skill.isError, true);
  assert.match(skill.content.map((part) => part.text).join("\n"), /Use TRUST for the next task/);

  assert.ok((await stat(path.join(dataDirectory, "pglite"))).isDirectory(), "the database lives in the data directory");
  assert.ok((await stat(path.join(dataDirectory, "operations"))).isDirectory(), "the Operation sources directory");
  assert.deepEqual(await readdir(path.join(dataDirectory, "operations")), []);
});

test("DIST-010 AC2 the packed package contains only runtime files and declares its license and Node version", async () => {
  const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  const root = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.license, "MIT");
  const license = await readFile(path.join(installed, "LICENSE"), "utf8");
  assert.equal(license, await readFile(path.join(repositoryRoot, "LICENSE"), "utf8"));
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 Alexandre Boyer\n/);
  assert.equal(manifest.engines.node, root.engines.node);
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.bin, { trust: "bin/trust.js" });
  assert.deepEqual(manifest.bundleDependencies, Object.keys(manifest.dependencies));

  const files = packed.files.map((file) => file.path);
  assert.ok(files.length > 0);
  const allowed =
    /^(package\.json|README\.md|LICENSE|bin\/trust\.js|lib\/cli\.js|lib\/runtime\/(index|child)\.js|documentation\/catalog\.json|skills\/(trust|trust-operations)\/.+|web\/.+|node_modules\/@electric-sql\/pglite\/.+)$/;
  assert.deepEqual(
    files.filter((file) => !allowed.test(file)),
    [],
    "only runtime entries are packaged",
  );
  const forbidden =
    /(^|\/)(acceptance|__tests__|tests?|src|environments|\.trust|\.git)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.map$|\.tsx?$|\.d\.[cm]?ts$|(^|\/)\.env|(^|\/)\.npmrc$|\.(pem|key|sqlite|db|log)$/;
  assert.deepEqual(
    files.filter((file) => forbidden.test(file)),
    [],
    "no test sources, source maps, development data or secrets",
  );
  for (const required of [
    "LICENSE",
    "lib/runtime/index.js",
    "web/index.html",
    "skills/trust/scripts/run.js",
    "skills/trust-operations/SKILL.md",
    "node_modules/@electric-sql/pglite/package.json",
  ])
    assert.ok(files.includes(required), required);

  const contents = await filesUnder(installed);
  const leaks = Object.entries(contents)
    .filter(([, content]) => content.includes(repositoryRoot) || PRIVATE_KEY.test(content.toString("latin1")))
    .map(([file]) => file);
  assert.deepEqual(leaks, [], "packaged files embed neither the build checkout path nor private keys");
});

test("DIST-020 AC1 trust setup connects a Claude Code project with skills, Runner, MCP and endpoints", async () => {
  const project = await newProject("claude-code");
  const { stdout } = await trust(["setup", project, "--url", serverUrl, "--agent", "claude-code"], workspace);
  assert.match(stdout, /TRUST setup \(claude-code\)/);

  assert.deepEqual(
    await readFile(path.join(project, ".claude/skills/trust-operations/SKILL.md")),
    await readFile(path.join(installed, "skills/trust-operations/SKILL.md")),
  );
  const runner = path.join(project, ".claude/skills/trust");
  for (const file of RUNNER_FILES) assert.ok((await stat(path.join(runner, file))).size > 0, file);

  const mcpConfiguration = JSON.parse(await readFile(path.join(project, ".mcp.json"), "utf8"));
  assert.deepEqual(mcpConfiguration.mcpServers.trust, { type: "http", url: `${serverUrl}/mcp` });
  const settings = JSON.parse(await readFile(path.join(project, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.env, {
    TRUST_RPC_ENDPOINT: `${serverUrl}/rpc`,
    TRUST_OTLP_ENDPOINT: `${serverUrl}/v1/traces`,
  });
  assert.equal(existsSync(path.join(project, ".codex")), false);
  assert.equal(existsSync(path.join(project, ".agents")), false);

  const tools = (await mcp(mcpConfiguration.mcpServers.trust.url, "tools/list", {})).tools;
  assert.ok(tools.some((tool) => tool.name === "trust_plan_read"));
  await probeRunner(runner, settings.env, project);
});

test("DIST-020 AC2 trust setup connects a Codex project and merges its configuration", async () => {
  const project = await newProject("codex");
  const original = [
    "# Project settings",
    'model = "gpt-5"',
    "",
    "[mcp_servers.docs]",
    'url = "http://127.0.0.1:9/mcp"',
    "",
    "[shell_environment_policy]",
    'inherit = "core"',
    "",
    "[shell_environment_policy.set]",
    'PROJECT_MODE = "local"',
  ];
  await mkdir(path.join(project, ".codex"));
  await writeFile(path.join(project, ".codex/config.toml"), `${original.join("\n")}\n`);

  const { stdout } = await trust(["setup", project, "--url", serverUrl, "--agent", "codex"], workspace);
  assert.match(stdout, /TRUST setup \(codex\)/);

  assert.deepEqual(
    await readFile(path.join(project, ".agents/skills/trust-operations/SKILL.md")),
    await readFile(path.join(installed, "skills/trust-operations/SKILL.md")),
  );
  const runner = path.join(project, ".agents/skills/trust");
  for (const file of RUNNER_FILES) assert.ok((await stat(path.join(runner, file))).size > 0, file);

  const configuration = await readFile(path.join(project, ".codex/config.toml"), "utf8");
  assertSubsequence(configuration.split("\n"), original, "config.toml");
  assert.deepEqual(tomlTables(configuration), [
    "[mcp_servers.docs]",
    "[shell_environment_policy]",
    "[shell_environment_policy.set]",
    "[mcp_servers.trust]",
  ]);
  assert.deepEqual(tomlData(configuration), {
    model: "gpt-5",
    mcp_servers: {
      docs: { url: "http://127.0.0.1:9/mcp" },
      trust: { url: `${serverUrl}/mcp`, enabled: true },
    },
    shell_environment_policy: {
      inherit: "core",
      set: {
        PROJECT_MODE: "local",
        TRUST_RPC_ENDPOINT: `${serverUrl}/rpc`,
        TRUST_OTLP_ENDPOINT: `${serverUrl}/v1/traces`,
      },
    },
  });
  const endpoints = {
    TRUST_RPC_ENDPOINT: tomlValue(configuration, "shell_environment_policy.set", "TRUST_RPC_ENDPOINT"),
    TRUST_OTLP_ENDPOINT: tomlValue(configuration, "shell_environment_policy.set", "TRUST_OTLP_ENDPOINT"),
  };
  assert.deepEqual(endpoints, {
    TRUST_RPC_ENDPOINT: `${serverUrl}/rpc`,
    TRUST_OTLP_ENDPOINT: `${serverUrl}/v1/traces`,
  });
  assert.equal(tomlValue(configuration, "shell_environment_policy.set", "PROJECT_MODE"), "local");
  assert.equal(existsSync(path.join(project, ".claude")), false);
  assert.equal(existsSync(path.join(project, ".mcp.json")), false);

  const tools = (await mcp(tomlValue(configuration, "mcp_servers.trust", "url"), "tools/list", {})).tools;
  assert.ok(tools.some((tool) => tool.name === "trust_plan_read"));
  await probeRunner(runner, endpoints, project);

  // An earlier stdio TRUST server is replaced as a whole: an HTTP server with command/args is invalid for Codex.
  const stdio = await newProject("codex-stdio");
  await mkdir(path.join(stdio, ".codex"));
  await writeFile(
    path.join(stdio, ".codex/config.toml"),
    [
      "[mcp_servers.trust]",
      'command = "node"',
      'args = ["/opt/trust/scripts/mcp-stdio.js"]',
      "",
      "[mcp_servers.trust.env]",
      'TRUST_RPC_ENDPOINT = "http://127.0.0.1:1/rpc"',
      "",
      "[mcp_servers.docs]",
      'command = "docs-mcp"',
      "",
    ].join("\n"),
  );
  await trust(["setup", stdio, "--url", serverUrl, "--agent", "codex"], workspace);
  const replaced = tomlData(await readFile(path.join(stdio, ".codex/config.toml"), "utf8"));
  assert.deepEqual(replaced.mcp_servers, {
    trust: { url: `${serverUrl}/mcp`, enabled: true },
    docs: { command: "docs-mcp" },
  });

  // A refused config.toml leaves the project untouched, including the Claude Code files of the same run.
  for (const [name, source] of [
    ["codex-malformed", '[mcp_servers.docs\nurl = "http://127.0.0.1:9/mcp"\n'],
    ["codex-inline", '[mcp_servers]\ntrust = { command = "node" }\n'],
  ]) {
    const refused = await newProject(name);
    await mkdir(path.join(refused, ".codex"));
    await writeFile(path.join(refused, ".codex/config.toml"), source);
    await assert.rejects(trust(["setup", refused, "--url", serverUrl], workspace), /Refusing to change .*config\.toml/);
    assert.deepEqual(Object.keys(await filesUnder(refused)), [".codex/config.toml"], `${name}: nothing is written`);
    assert.equal(await readFile(path.join(refused, ".codex/config.toml"), "utf8"), source);
  }
});

test("DIST-020 AC3 running trust setup again duplicates nothing and keeps unrelated configuration", async () => {
  const project = await newProject("rerun");
  await mkdir(path.join(project, ".claude/skills/trust-operations/references"), { recursive: true });
  await mkdir(path.join(project, ".claude/skills/review"), { recursive: true });
  await mkdir(path.join(project, ".codex"));
  const userFiles = {
    ".mcp.json": `${JSON.stringify({ mcpServers: { docs: { type: "http", url: "http://127.0.0.1:9/mcp" } }, note: "kept" }, null, 2)}\n`,
    ".claude/settings.json": `${JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, env: { PROJECT_MODE: "local", TRUST_RPC_ENDPOINT: "http://127.0.0.1:1/rpc" } }, null, 2)}\n`,
    ".claude/skills/trust-operations/references/project.md": "# Project scope\n",
    ".claude/skills/review/SKILL.md": "---\nname: review\n---\n",
    ".codex/config.toml":
      '# Project settings\nmodel = "gpt-5"\n\n[mcp_servers.trust]\nurl = "http://127.0.0.1:1/mcp" # stale\n\n[mcp_servers.docs]\nurl = "http://127.0.0.1:9/mcp"\n\n[shell_environment_policy.set]\nPROJECT_MODE = "local"\n',
  };
  for (const [file, content] of Object.entries(userFiles)) await writeFile(path.join(project, file), content);

  await trust(["setup", project, "--url", serverUrl], workspace);
  const first = await filesUnder(project);
  await trust(["setup", project, "--url", serverUrl], workspace);
  const second = await filesUnder(project);
  assert.deepEqual(Object.keys(second), Object.keys(first), "a second setup adds or removes no file");
  for (const [file, content] of Object.entries(first)) assert.ok(second[file].equals(content), `${file} changed`);
  for (const skills of [".claude/skills", ".agents/skills"])
    assert.deepEqual(
      (await readdir(path.join(project, skills))).filter((name) => name.startsWith(".")),
      [],
      `${skills} keeps no staging or backup directory`,
    );

  const mcpConfiguration = JSON.parse(second[".mcp.json"].toString("utf8"));
  assert.deepEqual(mcpConfiguration, {
    mcpServers: {
      docs: { type: "http", url: "http://127.0.0.1:9/mcp" },
      trust: { type: "http", url: `${serverUrl}/mcp` },
    },
    note: "kept",
  });
  const settings = JSON.parse(second[".claude/settings.json"].toString("utf8"));
  assert.deepEqual(settings, {
    permissions: { allow: ["Bash(npm test)"] },
    env: {
      PROJECT_MODE: "local",
      TRUST_RPC_ENDPOINT: `${serverUrl}/rpc`,
      TRUST_OTLP_ENDPOINT: `${serverUrl}/v1/traces`,
    },
  });
  assert.equal(second[".claude/skills/trust-operations/references/project.md"].toString("utf8"), "# Project scope\n");
  assert.equal(second[".claude/skills/review/SKILL.md"].toString("utf8"), "---\nname: review\n---\n");

  const configuration = second[".codex/config.toml"].toString("utf8");
  assert.deepEqual(tomlTables(configuration), [
    "[mcp_servers.trust]",
    "[mcp_servers.docs]",
    "[shell_environment_policy.set]",
  ]);
  assert.equal(configuration.match(/^\s*url\s*=/gm).length, 2);
  assert.equal(configuration.match(/TRUST_RPC_ENDPOINT/g).length, 1);
  assert.equal(tomlValue(configuration, "mcp_servers.trust", "url"), `${serverUrl}/mcp`);
  assert.equal(tomlValue(configuration, "mcp_servers.docs", "url"), "http://127.0.0.1:9/mcp");
  assert.equal(tomlValue(configuration, "shell_environment_policy.set", "PROJECT_MODE"), "local");
  assertSubsequence(
    configuration.split("\n"),
    ["# Project settings", 'model = "gpt-5"', "", "[mcp_servers.trust]"],
    "config.toml",
  );

  const refused = await newProject("refused");
  await writeFile(path.join(refused, ".mcp.json"), '{ "mcpServers": { "docs": ');
  await assert.rejects(trust(["setup", refused, "--url", serverUrl], workspace), /Refusing to change .*\.mcp\.json/);
  assert.deepEqual(Object.keys(await filesUnder(refused)), [".mcp.json"], "a refused setup writes nothing");
  assert.equal(await readFile(path.join(refused, ".mcp.json"), "utf8"), '{ "mcpServers": { "docs": ');
});
