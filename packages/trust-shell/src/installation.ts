import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface TrustInstallation {
  readonly root: string;
  readonly runtimeEntry: string;
  readonly operationsDirectory: string;
  readonly webDirectory: string;
  readonly runnerPackageRoot: string;
  readonly runnerSkillSource: string;
}

export function resolveTrustInstallation(explicitRoot?: string): TrustInstallation {
  const candidates = explicitRoot === undefined
    ? ancestors(process.cwd()).concat(ancestors(packageRoot))
    : [absolutePath(explicitRoot, "TRUST installation root")];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (seen.has(root)) continue;
    seen.add(root);
    const installation = trustInstallationAt(root);
    if (isInstallation(installation)) return installation;
  }
  const source = explicitRoot === undefined ? "the current checkout" : explicitRoot;
  throw new Error(
    `TRUST installation not found at ${source}. Build the runtime and web application before using the shell.`,
  );
}

export function trustInstallationAt(root: string): TrustInstallation {
  return {
    root,
    runtimeEntry: path.join(root, "packages/trust-runtime/dist/src/index.js"),
    operationsDirectory: path.join(root, "assets/operations"),
    webDirectory: path.join(root, "apps/trust-web/dist"),
    runnerPackageRoot: path.join(root, "packages/trust-runner"),
    runnerSkillSource: path.join(root, "assets/skills/trust"),
  };
}

function isInstallation(value: TrustInstallation): boolean {
  return existsSync(value.runtimeEntry)
    && existsSync(path.join(value.webDirectory, "index.html"))
    && existsSync(path.join(value.operationsDirectory, "git.head-read.feature"))
    && existsSync(path.join(value.runnerSkillSource, "SKILL.md"))
    && existsSync(path.join(value.runnerPackageRoot, "scripts/run.ts"));
}

function ancestors(start: string): string[] {
  const values: string[] = [];
  let current = path.resolve(start);
  while (true) {
    values.push(current);
    const parent = path.dirname(current);
    if (parent === current) return values;
    current = parent;
  }
}

function absolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  return path.resolve(value);
}
