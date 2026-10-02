import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * The files one TRUST installation serves. A checkout builds them in its workspace packages; the npm
 * distribution ships them prebuilt (see the package README for its layout).
 */
export interface TrustInstallation {
  readonly root: string;
  readonly runtimeEntry: string;
  readonly operationsDirectory: string;
  readonly webDirectory: string;
  /** Workspace package whose sources build the Runner; absent when `runnerSkillSource` is already packaged. */
  readonly runnerPackageRoot?: string;
  readonly runnerSkillSource: string;
  readonly operationsSkillSource: string;
}

export function resolveTrustInstallation(explicitRoot?: string): TrustInstallation {
  const ownDistribution = distributionRoot();
  const candidates =
    explicitRoot === undefined
      ? [
          ...(ownDistribution === undefined ? [] : [ownDistribution]),
          ...ancestors(process.cwd()),
          ...ancestors(moduleDirectory),
        ]
      : [absolutePath(explicitRoot, "TRUST installation root")];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (seen.has(root)) continue;
    seen.add(root);
    for (const installation of [trustInstallationAt(root), distributionInstallationAt(root)])
      if (isInstallation(installation)) return installation;
  }
  const source = explicitRoot === undefined ? "the current checkout" : explicitRoot;
  throw new Error(
    `TRUST installation not found at ${source}. Build the runtime and web application before using the shell.`,
  );
}

/** Layout of a built TRUST checkout. */
export function trustInstallationAt(root: string): TrustInstallation {
  return {
    root,
    runtimeEntry: path.join(root, "packages/trust-runtime/dist/src/index.js"),
    operationsDirectory: path.join(root, "assets/operations"),
    webDirectory: path.join(root, "apps/trust-web/dist"),
    runnerPackageRoot: path.join(root, "packages/trust-runner"),
    runnerSkillSource: path.join(root, "assets/skills/trust"),
    operationsSkillSource: path.join(root, "assets/skills/trust-operations"),
  };
}

/** Layout of the npm distribution, whose Runner skill is already packaged. */
export function distributionInstallationAt(root: string): TrustInstallation {
  return {
    root,
    runtimeEntry: path.join(root, "lib/runtime/index.js"),
    operationsDirectory: path.join(root, "operations"),
    webDirectory: path.join(root, "web"),
    runnerSkillSource: path.join(root, "skills/trust"),
    operationsSkillSource: path.join(root, "skills/trust-operations"),
  };
}

/** Packaged Runner trial script used when the configuration does not name one. */
export function defaultRunnerTrialScript(): string {
  const root = distributionRoot();
  return root === undefined
    ? path.resolve(moduleDirectory, "../../../trust-runner/dist/skill/trust/scripts/trial.js")
    : path.join(distributionInstallationAt(root).runnerSkillSource, "scripts/trial.js");
}

/** Version of the shell package that contains this module (the published package in a distribution). */
export function trustShellVersion(): string {
  for (const directory of ancestors(moduleDirectory)) {
    const manifest = path.join(directory, "package.json");
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { readonly version?: unknown };
    if (typeof parsed.version !== "string") throw new Error(`No version in ${manifest}`);
    return parsed.version;
  }
  throw new Error("TRUST shell package manifest not found");
}

/** Root of the npm distribution that contains this module, if it runs from one. */
function distributionRoot(): string | undefined {
  const root = path.resolve(moduleDirectory, "..");
  return isInstallation(distributionInstallationAt(root)) ? root : undefined;
}

function isInstallation(value: TrustInstallation): boolean {
  return (
    existsSync(value.runtimeEntry) &&
    existsSync(path.join(value.webDirectory, "index.html")) &&
    existsSync(path.join(value.operationsDirectory, "git.head-read.feature")) &&
    existsSync(path.join(value.runnerSkillSource, "SKILL.md")) &&
    existsSync(path.join(value.operationsSkillSource, "SKILL.md")) &&
    (value.runnerPackageRoot === undefined
      ? existsSync(path.join(value.runnerSkillSource, "scripts/run.js"))
      : existsSync(path.join(value.runnerPackageRoot, "scripts/run.ts")))
  );
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
