import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  publicTrustConfiguration,
  type RegistryPackageCatalog,
  type RegistryPackageInstallation,
  type RegistryPackageUninstallation,
  type RegistryPackageUpdate,
  type RegistrySource,
  type RegistrySourceIndexView,
  type RegistrySourceRemoval,
} from "@trust/extension-sdk";
import { matchRegistrySource } from "@trust/extension-sdk/match";
import { readServerConfiguration } from "./configuration.js";

import { resolveTrustInstallation, trustShellVersion } from "./installation.js";
import { SETUP_AGENTS, type SetupAgent, setupProject, trustEndpoints } from "./project-setup.js";
import { callTrustRpc } from "./rpc-client.js";
import { deployRunner } from "./runner-deployment.js";
import { readTrustServerStatus, startTrustServer } from "./server.js";

export async function runTrustCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (arguments_.length === 1 && (arguments_[0] === "--version" || arguments_[0] === "version")) {
    process.stdout.write(`${trustShellVersion()}\n`);
    return;
  }
  if (arguments_[0] === "start") {
    await startServer(startOptions(arguments_.slice(1)));
    return;
  }
  if (arguments_[0] === "setup") {
    await runSetup(arguments_.slice(1));
    return;
  }
  if (arguments_[0] === "server" && arguments_[1] === "config" && arguments_.length === 2) {
    process.stdout.write(`${JSON.stringify(publicTrustConfiguration(await readServerConfiguration()), null, 2)}\n`);
    return;
  }
  if (arguments_[0] === "server" && arguments_[1] === "start" && arguments_.length === 2) {
    await startServer({});
    return;
  }
  if (arguments_[0] === "server" && arguments_[1] === "status" && arguments_.length === 2) {
    const { configuration } = await readServerConfiguration();
    const status = await readTrustServerStatus(
      configuration.server.host,
      configuration.server.webPort,
      configuration.shell.webAccessPassword,
    );
    process.stdout.write(
      status.running ? `TRUST server: running at ${status.url}\n` : `TRUST server: stopped (${status.url})\n`,
    );
    if (!status.running) process.exitCode = 1;
    return;
  }
  const [, , destination] = arguments_;
  if (
    arguments_[0] === "runner" &&
    arguments_[1] === "deploy" &&
    arguments_.length === 3 &&
    destination !== undefined
  ) {
    const installation = resolveTrustInstallation((await readServerConfiguration()).configuration.shell.installRoot);
    const deployed = await deployRunner(installation, destination);
    process.stdout.write(`TRUST Runner deployed at ${deployed}\n`);
    return;
  }
  if (arguments_[0] === "rpc") {
    await runRpcCommand(arguments_.slice(1));
    return;
  }
  if (arguments_[0] === "registry") {
    await runRegistryCommand(arguments_.slice(1));
    return;
  }
  throw new TypeError(USAGE);
}

const USAGE = [
  "usage: trust --version | trust --help",
  "       trust start [--port <web-port>] [--runtime-port <port>] [--data-dir <directory>] [--host <host>]",
  `       trust setup <project-directory> [--url <server-url>] [--agent <${SETUP_AGENTS.join("|")}>]...`,
  "       trust server start | trust server status | trust server config",
  "       trust runner deploy <absolute-directory>",
  "       trust rpc <method> [<json-params>] [--text <field>=<file>]... [--field <path>]",
  "       trust registry <list|add|remove|sync|refresh|packages|installed|install|update|uninstall>",
].join("\n");

/** `trust start` options, as the configuration environment variables they override. */
function startOptions(arguments_: readonly string[]): Readonly<Record<string, string>> {
  const names: Readonly<Record<string, string>> = {
    "--port": "TRUST_WEB_PORT",
    "--runtime-port": "TRUST_PORT",
    "--data-dir": "TRUST_SERVER_STATE_DIRECTORY",
    "--host": "TRUST_HOST",
  };
  const overrides: Record<string, string> = {};
  for (const [flag, value] of optionPairs(arguments_)) {
    const name = names[flag];
    if (name === undefined || overrides[name] !== undefined) throw new TypeError(USAGE);
    overrides[name] = flag === "--data-dir" ? path.resolve(value) : value;
  }
  return overrides;
}

async function startServer(overrides: Readonly<Record<string, string>>): Promise<void> {
  const resolved = await readServerConfiguration({ ...process.env, ...overrides });
  const { configuration } = resolved;
  const installation = resolveTrustInstallation(configuration.shell.installRoot);
  const { host, webPort } = configuration.server;
  const existing = await readTrustServerStatus(host, webPort, configuration.shell.webAccessPassword);
  if (existing.running) {
    process.stdout.write(`TRUST server: already running at ${existing.url}\n`);
    return;
  }
  const server = await startTrustServer({
    installation,
    host,
    runtimePort: configuration.server.port,
    configuration: resolved,
    webPort,
    stateDirectory: configuration.server.stateDirectory,
  });
  const endpoints = trustEndpoints(server.url);
  process.stdout.write(
    [
      `TRUST server: running at ${server.url}`,
      `TRUST interface: ${server.url}/`,
      `TRUST RPC: ${endpoints.rpc}`,
      `TRUST MCP: ${endpoints.mcp}`,
      `TRUST OTLP: ${endpoints.otlp}`,
      `TRUST runtime: ${server.runtimeUrl}`,
      `TRUST data: ${configuration.server.stateDirectory}`,
      `Connect a project: trust setup <project-directory> --url ${server.url}`,
      "",
    ].join("\n"),
  );
  await waitForShutdown(server.close);
}

async function runSetup(arguments_: readonly string[]): Promise<void> {
  const [project, ...flags] = arguments_;
  if (project === undefined || project.startsWith("--")) throw new TypeError(USAGE);
  let url: string | undefined;
  const agents: SetupAgent[] = [];
  for (const [flag, value] of optionPairs(flags)) {
    if (flag === "--url" && url === undefined) url = value;
    else if (flag === "--agent") {
      const agent = SETUP_AGENTS.find((candidate) => candidate === value);
      if (agent === undefined || agents.includes(agent)) throw new TypeError(USAGE);
      agents.push(agent);
    } else throw new TypeError(USAGE);
  }
  const { configuration } = await readServerConfiguration();
  const installation = resolveTrustInstallation(configuration.shell.installRoot);
  const endpoints = trustEndpoints(url ?? configuration.shell.url);
  for (const result of await setupProject(
    installation,
    project,
    agents.length === 0 ? SETUP_AGENTS : agents,
    endpoints,
  ))
    process.stdout.write(
      [
        `TRUST setup (${result.agent}): ${path.resolve(project)}`,
        `  skills: ${result.skillsDirectory} (trust-operations, trust Runner)`,
        `  MCP: ${result.mcpConfiguration} -> ${endpoints.mcp}`,
        `  Runner endpoints: ${result.endpointConfiguration} -> ${endpoints.rpc}, ${endpoints.otlp}`,
        "",
      ].join("\n"),
    );
}

/**
 * Calls one runtime RPC method on the server named by TRUST_URL. `--text` places a file's content in a
 * string parameter; `--field` prints one value of the result (a string without quotes).
 */
async function runRpcCommand(arguments_: readonly string[]): Promise<void> {
  const [method, ...rest] = arguments_;
  if (method === undefined || method.startsWith("--")) throw new TypeError(USAGE);
  const literal = rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : undefined;
  let params: unknown;
  try {
    params = JSON.parse(literal ?? "{}");
  } catch {
    throw new TypeError(`Invalid JSON parameters for ${method}`);
  }
  if (typeof params !== "object" || params === null || Array.isArray(params))
    throw new TypeError(`The parameters of ${method} must be a JSON object`);
  const values = params as Record<string, unknown>;
  let field: string | undefined;
  for (const [flag, value] of optionPairs(rest.slice(literal === undefined ? 0 : 1))) {
    if (flag === "--field" && field === undefined) field = value;
    else if (flag === "--text") {
      const separator = value.indexOf("=");
      if (separator < 1) throw new TypeError(USAGE);
      values[value.slice(0, separator)] = await readFile(path.resolve(value.slice(separator + 1)), "utf8");
    } else throw new TypeError(USAGE);
  }
  const { configuration } = await readServerConfiguration();
  let result: unknown = await callTrustRpc({ url: configuration.shell.url }, method, values);
  if (field !== undefined)
    for (const part of field.split(".")) {
      const index = /^\d+$/.test(part) ? Number(part) : part;
      const container = result as Record<string | number, unknown> | null;
      if (typeof container !== "object" || container === null || !(index in container))
        throw new Error(`The result of ${method} has no field ${field}`);
      result = container[index];
    }
  process.stdout.write(
    `${typeof result === "string" && field !== undefined ? result : JSON.stringify(result, null, 2)}\n`,
  );
}

function optionPairs(arguments_: readonly string[]): (readonly [string, string])[] {
  if (arguments_.length % 2 !== 0) throw new TypeError(USAGE);
  const pairs: (readonly [string, string])[] = [];
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index] ?? "";
    const value = arguments_[index + 1] ?? "";
    if (!flag.startsWith("--") || value === "" || value.startsWith("--")) throw new TypeError(USAGE);
    pairs.push([flag, value]);
  }
  return pairs;
}

async function runRegistryCommand(arguments_: readonly string[]): Promise<void> {
  const options = { url: (await readServerConfiguration()).configuration.shell.url };
  const call = (method: string, params: unknown) => callTrustRpc(options, method, params);
  const [command, ...rest] = arguments_;
  if (command === "list" && rest.length === 0) {
    const result = (await call("registry.source.list", {})) as { readonly sources: readonly RegistrySource[] };
    if (result.sources.length === 0) {
      process.stdout.write("No registry sources configured.\n");
      return;
    }
    for (const source of result.sources) {
      const reference = matchRegistrySource(source, {
        git: (git) => (git.reference === undefined ? "" : ` (ref: ${git.reference})`),
        http: () => "",
        file: () => "",
      });
      process.stdout.write(`${source.name}\t${source.kind}\t${source.url}${reference}\n`);
    }
    return;
  }
  if (command === "add" && (rest.length === 3 || rest.length === 5)) {
    const [name, kind, url, flag, reference] = rest;
    if (kind !== "git" && kind !== "http" && kind !== "file") throw registryUsage();
    if (rest.length === 5 && (kind !== "git" || flag !== "--ref" || reference === undefined)) throw registryUsage();
    const result = (await call("registry.source.save", {
      name,
      kind,
      url,
      ...(reference === undefined ? {} : { reference }),
    })) as { readonly source: RegistrySource };
    process.stdout.write(`Registry source ${result.source.name} saved.\n`);
    return;
  }
  if (command === "remove" && rest.length === 1) {
    const result = (await call("registry.source.remove", { name: rest[0] })) as RegistrySourceRemoval;
    process.stdout.write(
      result.removed
        ? `Registry source ${result.name} removed.\n`
        : `Registry source ${result.name} was not configured.\n`,
    );
    if (result.keptPackages.length > 0)
      process.stdout.write(`Installed packages kept: ${result.keptPackages.join(", ")}\n`);
    return;
  }
  if (command === "sync" && rest.length === 1) {
    const result = (await call("registry.source.sync", { name: rest[0] })) as {
      readonly source: RegistrySource;
      readonly summary: { readonly imported: number; readonly unchanged: number };
    };
    process.stdout.write(
      `Registry source ${result.source.name} synchronized: ${result.summary.imported} imported, ${result.summary.unchanged} unchanged.\n`,
    );
    return;
  }
  if ((command === "refresh" || command === "packages") && rest.length === 1) {
    const index = (await call(command === "refresh" ? "registry.source.refresh" : "registry.source.read", {
      name: rest[0],
    })) as RegistrySourceIndexView;
    process.stdout.write(`Registry source ${index.source.name} at ${index.revision} (read ${index.refreshedAt})\n`);
    for (const value of index.packages)
      process.stdout.write(
        `${value.name}\t${value.version}\t${value.categories.join(",")}\t${value.installedVersion === null ? "not installed" : `installed ${value.installedVersion}`}\n`,
      );
    return;
  }
  if (command === "installed" && rest.length === 0) {
    const catalog = (await call("registry.package.list", {})) as RegistryPackageCatalog;
    for (const value of catalog.packages)
      process.stdout.write(
        `${value.name}\t${value.version}\t${value.source}\t${value.latestVersion !== null && value.latestVersion !== value.version ? `available ${value.latestVersion}` : "current"}\n`,
      );
    return;
  }
  if (command === "install" && rest.length >= 3) {
    const [source, name, version, ...flags] = rest;
    const values = flagValues(flags, ["--environment", "--grant", "--settings", "--credential-environment"]);
    const environment = values.get("--environment")?.[0];
    const result = (await call("registry.package.install", {
      source,
      package: name,
      version,
      ...(environment === undefined
        ? {}
        : {
            extension: {
              environment,
              grants: values.get("--grant") ?? [],
              credentialEnvironment: values.get("--credential-environment") ?? [],
              settings: JSON.parse(values.get("--settings")?.[0] ?? "{}") as unknown,
            },
          }),
    })) as RegistryPackageInstallation;
    process.stdout.write(
      `Package ${result.package.name}@${result.package.version} installed at ${result.package.directory} (build ${result.steps.build}).\n`,
    );
    return;
  }
  if (command === "update" && rest.length === 2) {
    const result = (await call("registry.package.update", {
      package: rest[0],
      version: rest[1],
    })) as RegistryPackageUpdate;
    process.stdout.write(
      `Package ${result.package.name} updated from ${result.previousVersion} to ${result.package.version}.\n`,
    );
    return;
  }
  if (command === "uninstall" && (rest.length === 1 || (rest.length === 2 && rest[1] === "--delete-data"))) {
    const result = (await call("registry.package.uninstall", {
      package: rest[0],
      ...(rest.length === 2 ? { deleteData: true } : {}),
    })) as RegistryPackageUninstallation;
    const describe = (items: RegistryPackageUninstallation["removed"]) =>
      items.map((item) => `${item.kind} ${item.name}${item.version ? `@${item.version}` : ""}`).join("; ");
    process.stdout.write(`Package ${result.package.name}@${result.package.version} uninstalled.\n`);
    process.stdout.write(`Removed: ${describe(result.removed)}\nKept: ${describe(result.kept)}\n`);
    return;
  }
  throw registryUsage();
}

function flagValues(flags: readonly string[], names: readonly string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index] ?? "";
    const value = flags[index + 1];
    if (!names.includes(name) || value === undefined) throw registryUsage();
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return values;
}

function registryUsage(): TypeError {
  return new TypeError(
    [
      "usage: trust registry list | add <name> <git|http|file> <url-or-absolute-path> [--ref <reference>] | remove <name> | sync <name>",
      "       trust registry refresh <source> | packages <source> | installed",
      "       trust registry install <source> <package> <version> [--environment <name> [--grant <capability>]... [--credential-environment <VARIABLE>]... [--settings <json>]]",
      "       trust registry update <package> <version> | uninstall <package> [--delete-data]",
    ].join("\n"),
  );
}

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

// Last statement: every declaration above is initialized before a command runs.
await runTrustCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
