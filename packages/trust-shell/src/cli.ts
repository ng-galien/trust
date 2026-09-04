import path from "node:path";

import { resolveTrustInstallation } from "./installation.js";
import { callTrustRpc } from "./rpc-client.js";
import { deployRunner } from "./runner-deployment.js";
import { readTrustServerStatus, startTrustServer } from "./server.js";

await runTrustCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export async function runTrustCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_[0] === "server" && arguments_[1] === "start" && arguments_.length === 2) {
    const installation = resolveTrustInstallation(process.env.TRUST_INSTALL_ROOT);
    const host = process.env.TRUST_HOST ?? "127.0.0.1";
    const webPort = environmentPort("TRUST_WEB_PORT", 4173);
    const existing = await readTrustServerStatus(host, webPort);
    if (existing.running) {
      process.stdout.write(`TRUST server: already running at ${existing.url}\n`);
      return;
    }
    const server = await startTrustServer({
      installation,
      host,
      runtimePort: environmentPort("TRUST_PORT", 4318),
      webPort,
      stateDirectory: path.resolve(process.env.TRUST_SERVER_STATE_DIRECTORY ?? ".trust/server"),
    });
    process.stdout.write(`TRUST server: running at ${server.url}\n`);
    process.stdout.write(`TRUST runtime: ${server.runtimeUrl}\n`);
    await waitForShutdown(server.close);
    return;
  }
  if (arguments_[0] === "server" && arguments_[1] === "status" && arguments_.length === 2) {
    const status = await readTrustServerStatus(
      process.env.TRUST_HOST ?? "127.0.0.1",
      environmentPort("TRUST_WEB_PORT", 4173),
    );
    process.stdout.write(status.running
      ? `TRUST server: running at ${status.url}\n`
      : `TRUST server: stopped (${status.url})\n`);
    if (!status.running) process.exitCode = 1;
    return;
  }
  if (arguments_[0] === "runner" && arguments_[1] === "deploy" && arguments_.length === 3) {
    const installation = resolveTrustInstallation(process.env.TRUST_INSTALL_ROOT);
    const deployed = await deployRunner(installation, arguments_[2]!);
    process.stdout.write(`TRUST Runner deployed at ${deployed}\n`);
    return;
  }
  if (arguments_[0] === "registry") {
    await runRegistryCommand(arguments_.slice(1));
    return;
  }
  throw new TypeError(
    "usage: trust server start | trust server status | trust runner deploy <absolute-directory> | trust registry <list|add|remove|sync>",
  );
}

async function runRegistryCommand(arguments_: readonly string[]): Promise<void> {
  const options = { url: trustServerUrl() };
  if (arguments_[0] === "list" && arguments_.length === 1) {
    const result = await callTrustRpc(options, "registry.source.list", {}) as RegistryCatalog;
    if (result.sources.length === 0) {
      process.stdout.write("No registry sources configured.\n");
      return;
    }
    for (const source of result.sources) {
      const reference = source.kind === "git" && source.reference !== undefined
        ? ` (ref: ${source.reference})`
        : "";
      process.stdout.write(`${source.name}\t${source.kind}\t${source.url}${reference}\n`);
    }
    return;
  }
  if (arguments_[0] === "add" && (arguments_.length === 4 || arguments_.length === 6)) {
    const [, name, kind, url, flag, reference] = arguments_;
    if (kind !== "git" && kind !== "http") throw registryUsage();
    if (arguments_.length === 6 && (kind !== "git" || flag !== "--ref" || reference === undefined)) {
      throw registryUsage();
    }
    const result = await callTrustRpc(options, "registry.source.save", {
      name,
      kind,
      url,
      ...(reference === undefined ? {} : { reference }),
    }) as { readonly source: RegistrySource };
    process.stdout.write(`Registry source ${result.source.name} saved.\n`);
    return;
  }
  if (arguments_[0] === "remove" && arguments_.length === 2) {
    const result = await callTrustRpc(options, "registry.source.remove", {
      name: arguments_[1],
    }) as { readonly name: string; readonly removed: boolean };
    process.stdout.write(result.removed
      ? `Registry source ${result.name} removed.\n`
      : `Registry source ${result.name} was not configured.\n`);
    return;
  }
  if (arguments_[0] === "sync" && arguments_.length === 2) {
    const result = await callTrustRpc(options, "registry.source.sync", {
      name: arguments_[1],
    }) as RegistrySync;
    process.stdout.write(
      `Registry source ${result.source.name} synchronized: ${result.summary.imported} imported, ${result.summary.unchanged} unchanged.\n`,
    );
    return;
  }
  throw registryUsage();
}

function trustServerUrl(): string {
  return process.env.TRUST_URL
    ?? `http://${process.env.TRUST_HOST ?? "127.0.0.1"}:${environmentPort("TRUST_WEB_PORT", 4173)}`;
}

function registryUsage(): TypeError {
  return new TypeError(
    "usage: trust registry list | trust registry add <name> <git|http> <url> [--ref <reference>] | trust registry remove <name> | trust registry sync <name>",
  );
}

interface RegistrySource {
  readonly name: string;
  readonly kind: "git" | "http";
  readonly url: string;
  readonly reference?: string;
}

interface RegistryCatalog {
  readonly sources: readonly RegistrySource[];
}

interface RegistrySync {
  readonly source: RegistrySource;
  readonly summary: { readonly imported: number; readonly unchanged: number };
}

function environmentPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`Invalid ${name}: ${raw}`);
  }
  return value;
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
