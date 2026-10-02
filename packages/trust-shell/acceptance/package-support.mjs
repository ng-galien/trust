import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const PACKAGE_NAME = "@ng-galien/trust";

/** The built outputs the npm package is staged from. */
export function assertBuiltCheckout() {
  for (const built of [
    "packages/trust-shell/dist/src/cli.js",
    "packages/trust-runtime/dist/src/index.js",
    "packages/trust-runtime/dist/documentation/catalog.json",
    "apps/trust-web/dist/index.html",
  ])
    assert.ok(existsSync(path.join(repositoryRoot, built)), `${built} is missing; run npm run build first`);
}

/**
 * A temporary workspace with its own HOME. Child processes never see the caller's TRUST endpoints, npm
 * settings or home configuration. The workspace path is real: npm drops bundled dependencies when it
 * packs through a symbolic link such as macOS /var.
 */
export async function createIsolatedWorkspace(prefix) {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  const home = path.join(workspace, "home");
  await mkdir(home);
  await writeFile(path.join(home, "npmrc"), "");
  await writeFile(path.join(home, "global-npmrc"), "");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(TRUST_|npm_|NODE_OPTIONS$|NODE_TEST)/i.test(name)),
  );
  const environment = {
    ...inherited,
    PATH: [path.dirname(process.execPath), inherited.PATH].filter(Boolean).join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: path.join(home, "npm-cache"),
    npm_config_userconfig: path.join(home, "npmrc"),
    npm_config_globalconfig: path.join(home, "global-npmrc"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  return { workspace, home, environment };
}

export function run(environment, command, arguments_, options = {}) {
  return execute(command, arguments_, { env: environment, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...options });
}

/** The npm CLI installed with the running Node, invoked without relying on PATH. */
export function npmCli() {
  const directory = path.dirname(process.execPath);
  for (const candidate of [
    path.join(directory, "npm"),
    path.join(directory, "../lib/node_modules/npm/bin/npm-cli.js"),
    path.join(directory, "node_modules/npm/bin/npm-cli.js"),
  ])
    if (existsSync(candidate) && realpathSync(candidate).endsWith("npm-cli.js")) return realpathSync(candidate);
  assert.fail(`npm is not installed beside ${process.execPath}`);
}

export function npm(environment, arguments_, cwd) {
  return run(environment, process.execPath, [npmCli(), ...arguments_], { cwd });
}

/** Stages the publishable package from the checkout and packs it with npm, as a maintainer would. */
export async function packTrustPackage(workspace, environment) {
  const staged = path.join(workspace, "package");
  await run(
    environment,
    process.execPath,
    [path.join(repositoryRoot, "packages/trust-shell/scripts/package-npm.mjs"), "--output", staged],
    { cwd: repositoryRoot },
  );
  const archives = path.join(workspace, "archives");
  await mkdir(archives);
  const report = JSON.parse(
    (await npm(environment, ["pack", staged, "--pack-destination", archives, "--json"], workspace)).stdout,
  );
  const packed = Array.isArray(report) ? report[0] : Object.values(report)[0];
  return { staged, packed, archive: path.join(archives, packed.filename) };
}

/** Distinct free loopback ports. */
export async function freePorts(count) {
  const ports = new Set();
  while (ports.size < count) {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    ports.add(probe.address().port);
    await new Promise((resolve) => probe.close(resolve));
  }
  return [...ports];
}
