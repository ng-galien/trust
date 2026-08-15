import { glob, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const rootManifest = await readManifest(join(root, "package.json"));
const workspacePatterns = rootManifest.content.workspaces;
if (!Array.isArray(workspacePatterns) || workspacePatterns.some((pattern) => typeof pattern !== "string")) {
  throw new TypeError("Root workspaces must be an array of paths or glob patterns.");
}

const workspaceManifestPaths = new Set();
for (const pattern of workspacePatterns) {
  for await (const path of glob(join(pattern, "package.json"), { cwd: root })) {
    workspaceManifestPaths.add(join(root, path));
  }
}
const manifests = [
  rootManifest,
  ...await Promise.all([...workspaceManifestPaths].sort().map(readManifest)),
];
const workspaceNames = new Set(
  manifests.slice(1).map(({ content }) => content.name).filter((name) => typeof name === "string"),
);
const usesByDependency = new Map();

for (const manifest of manifests) {
  const manifestName = relative(root, manifest.path) || "package.json";
  for (const section of dependencySections) {
    const dependencies = manifest.content[section];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new TypeError(`${manifestName} ${section} must be an object.`);
    }
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (workspaceNames.has(dependency)) continue;
      if (typeof version !== "string") {
        throw new TypeError(`${manifestName} ${section}.${dependency} must be a string.`);
      }
      const uses = usesByDependency.get(dependency) ?? [];
      uses.push({ manifest: manifestName, section, version });
      usesByDependency.set(dependency, uses);
    }
  }
}

const divergences = [];
for (const [dependency, uses] of usesByDependency) {
  const manifestsUsingDependency = new Set(uses.map(({ manifest }) => manifest));
  const versions = new Set(uses.map(({ version }) => version));
  if (manifestsUsingDependency.size < 2 || versions.size < 2) continue;
  divergences.push({ dependency, uses });
}

if (divergences.length > 0) {
  const details = divergences
    .sort((left, right) => compareText(left.dependency, right.dependency))
    .flatMap(({ dependency, uses }) => [
      `Shared dependency "${dependency}" has divergent versions:`,
      ...uses
        .sort((left, right) => compareText(left.manifest, right.manifest))
        .map(({ manifest, section, version }) => `  ${manifest} ${section}: ${version}`),
    ]);
  process.stderr.write(`${details.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Shared workspace dependency versions are aligned.\n");
}

async function readManifest(path) {
  return {
    path,
    content: JSON.parse(await readFile(path, "utf8")),
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
