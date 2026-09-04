import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { build } from "esbuild";

import type { TrustInstallation } from "./installation.js";

const REQUIRED_FILES = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/results.md",
  "scripts/run.js",
  "scripts/mcp-stdio.js",
  "scripts/trial.js",
] as const;

export async function packageRunnerSkill(
  installation: TrustInstallation,
  destination: string,
  options: { readonly replace?: boolean } = {},
): Promise<string> {
  const output = validateDestination(installation, destination);
  if (options.replace === true) await rm(output, { recursive: true, force: true });
  else if (await pathExists(output)) throw new Error(`Runner destination already exists: ${output}`);

  await mkdir(path.join(output, "scripts"), { recursive: true });
  try {
    await Promise.all([
      cp(path.join(installation.runnerSkillSource, "SKILL.md"), path.join(output, "SKILL.md")),
      cp(path.join(installation.runnerSkillSource, "agents"), path.join(output, "agents"), { recursive: true }),
      cp(path.join(installation.runnerSkillSource, "references"), path.join(output, "references"), { recursive: true }),
    ]);
    await build({
      absWorkingDir: installation.root,
      entryPoints: {
        run: path.join(installation.runnerPackageRoot, "scripts/run.ts"),
        "mcp-stdio": path.join(installation.runnerPackageRoot, "scripts/mcp-stdio.ts"),
        trial: path.join(installation.runnerPackageRoot, "scripts/trial.ts"),
      },
      bundle: true,
      platform: "node",
      format: "esm",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
      minify: true,
      target: "node24",
      outdir: path.join(output, "scripts"),
    });
    await assertRunnerPackage(output);
    return output;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

export async function deployRunner(
  installation: TrustInstallation,
  destination: string,
): Promise<string> {
  const target = validateDestination(installation, destination);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  await assertReplaceableDirectory(target);

  const nonce = `${process.pid}-${randomUUID()}`;
  const staging = path.join(parent, `.${path.basename(target)}.trust-staging-${nonce}`);
  const backup = path.join(parent, `.${path.basename(target)}.trust-backup-${nonce}`);
  let displaced = false;
  try {
    await packageRunnerSkill(installation, staging);
    if (await pathExists(target)) {
      await rename(target, backup);
      displaced = true;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (displaced) {
        await rename(backup, target);
        displaced = false;
      }
      throw error;
    }
    if (displaced) {
      displaced = false;
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (displaced && !await pathExists(target) && await pathExists(backup)) {
      await rename(backup, target);
      displaced = false;
    }
    if (!displaced) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function validateDestination(installation: TrustInstallation, destination: string): string {
  if (!path.isAbsolute(destination)) throw new TypeError("Runner destination must be an absolute path");
  const resolved = path.resolve(destination);
  const protectedRoots = [path.resolve(homedir()), installation.root];
  const forbidden = new Set([
    path.parse(resolved).root,
    installation.runnerPackageRoot,
    installation.runnerSkillSource,
  ]);
  if (
    forbidden.has(resolved)
    || protectedRoots.some((protectedRoot) => isSameOrAncestor(resolved, protectedRoot))
  ) {
    throw new TypeError(`Runner destination is unsafe: ${resolved}`);
  }
  return resolved;
}

function isSameOrAncestor(candidate: string, protectedPath: string): boolean {
  const relative = path.relative(candidate, protectedPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertReplaceableDirectory(destination: string): Promise<void> {
  try {
    const stat = await lstat(destination);
    if (stat.isSymbolicLink()) throw new TypeError(`Runner destination must not be a symbolic link: ${destination}`);
    if (!stat.isDirectory()) throw new TypeError(`Runner destination must be a directory: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertRunnerPackage(destination: string): Promise<void> {
  await Promise.all(REQUIRED_FILES.map(async (relative) => {
    const content = await readFile(path.join(destination, relative));
    if (content.byteLength === 0) throw new Error(`Packaged Runner file is empty: ${relative}`);
  }));
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
