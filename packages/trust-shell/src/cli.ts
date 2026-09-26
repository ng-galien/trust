import { publicTrustConfiguration } from "@trust/extension-sdk";
import { readServerConfiguration } from "./configuration.js";

import { resolveTrustInstallation } from "./installation.js";
import { callTrustRpc } from "./rpc-client.js";
import { deployRunner } from "./runner-deployment.js";
import { readTrustServerStatus, startTrustServer } from "./server.js";

await runTrustCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export async function runTrustCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_[0] === "server" && arguments_[1] === "config" && arguments_.length === 2) {
    process.stdout.write(`${JSON.stringify(publicTrustConfiguration(await readServerConfiguration()), null, 2)}\n`);
    return;
  }
  if (arguments_[0] === "server" && arguments_[1] === "start" && arguments_.length === 2) {
    const resolved = await readServerConfiguration();
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
    process.stdout.write(`TRUST server: running at ${server.url}\n`);
    process.stdout.write(`TRUST runtime: ${server.runtimeUrl}\n`);
    await waitForShutdown(server.close);
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
  if (arguments_[0] === "runner" && arguments_[1] === "deploy" && arguments_.length === 3) {
    const installation = resolveTrustInstallation((await readServerConfiguration()).configuration.shell.installRoot);
    const deployed = await deployRunner(installation, arguments_[2]!);
    process.stdout.write(`TRUST Runner deployed at ${deployed}\n`);
    return;
  }
  if (arguments_[0] === "registry") {
    await runRegistryCommand(arguments_.slice(1));
    return;
  }
  throw new TypeError(
    "usage: trust server start | trust server status | trust server config | trust runner deploy <absolute-directory> | trust registry <list|add|remove|sync>",
  );
}

async function runRegistryCommand(arguments_: readonly string[]): Promise<void> {
  const options = { url: (await readServerConfiguration()).configuration.shell.url };
  if (arguments_[0] === "list" && arguments_.length === 1) {
    const result = (await callTrustRpc(options, "registry.source.list", {})) as RegistryCatalog;
    if (result.sources.length === 0) {
      process.stdout.write("No registry sources configured.\n");
      return;
    }
    for (const source of result.sources) {
      const reference = source.kind === "git" && source.reference !== undefined ? ` (ref: ${source.reference})` : "";
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
    const result = (await callTrustRpc(options, "registry.source.save", {
      name,
      kind,
      url,
      ...(reference === undefined ? {} : { reference }),
    })) as { readonly source: RegistrySource };
    process.stdout.write(`Registry source ${result.source.name} saved.\n`);
    return;
  }
  if (arguments_[0] === "remove" && arguments_.length === 2) {
    const result = (await callTrustRpc(options, "registry.source.remove", {
      name: arguments_[1],
    })) as { readonly name: string; readonly removed: boolean };
    process.stdout.write(
      result.removed
        ? `Registry source ${result.name} removed.\n`
        : `Registry source ${result.name} was not configured.\n`,
    );
    return;
  }
  if (arguments_[0] === "sync" && arguments_.length === 2) {
    const result = (await callTrustRpc(options, "registry.source.sync", {
      name: arguments_[1],
    })) as RegistrySync;
    process.stdout.write(
      `Registry source ${result.source.name} synchronized: ${result.summary.imported} imported, ${result.summary.unchanged} unchanged.\n`,
    );
    return;
  }
  throw registryUsage();
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
