import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { distributionInstallationAt, type TrustInstallation } from "./installation.js";
import { packageRunnerSkill } from "./runner-deployment.js";

export const NPM_PACKAGE_NAME = "@ng-galien/trust";
/** Kept outside the bundles: its WebAssembly and data files load relative to its own modules. */
const BUNDLED_DEPENDENCIES = ["@electric-sql/pglite"] as const;
/** Optional native accelerators that the bundled libraries load only when installed. */
const OPTIONAL_NATIVE_MODULES = ["pg-native", "bufferutil", "utf-8-validate"] as const;
const ESM_REQUIRE_BANNER =
  'import { createRequire as __trustCreateRequire } from "node:module"; const require = __trustCreateRequire(import.meta.url);';

export interface StagedNpmPackage {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
}

/**
 * Assembles the publishable `@ng-galien/trust` package from a built checkout: bundled runtime and CLI,
 * built web interface, packaged Runner, agent skills, built-in Operations and documentation catalog.
 */
export async function stageNpmPackage(checkout: TrustInstallation, output: string): Promise<StagedNpmPackage> {
  const runnerPackageRoot = checkout.runnerPackageRoot;
  if (runnerPackageRoot === undefined) throw new TypeError("The npm package is staged from a built TRUST checkout");
  if (!path.isAbsolute(output)) throw new TypeError("Package output directory must be an absolute path");
  await mkdir(output, { recursive: true });
  // npm drops bundled dependencies when it packs through a symbolic link, so the real path is reported.
  const directory = await realpath(output);
  if ((await readdir(directory)).length > 0) throw new Error(`Package output directory is not empty: ${directory}`);

  const shellManifest = JSON.parse(
    await readFile(path.join(checkout.root, "packages/trust-shell/package.json"), "utf8"),
  ) as { readonly version: string; readonly engines: { readonly node: string } };
  const target = distributionInstallationAt(directory);
  const runtimeRoot = path.dirname(path.dirname(path.dirname(checkout.runtimeEntry)));
  const { build } = await import("esbuild");
  const common = {
    absWorkingDir: checkout.root,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: { js: ESM_REQUIRE_BANNER },
    legalComments: "eof",
    logLevel: "warning",
  } as const;
  await build({
    ...common,
    entryPoints: {
      index: checkout.runtimeEntry,
      child: path.join(path.dirname(checkout.runtimeEntry), "extensions/child.js"),
    },
    external: [...BUNDLED_DEPENDENCIES, ...OPTIONAL_NATIVE_MODULES],
    outdir: path.dirname(target.runtimeEntry),
  });
  await build({
    ...common,
    entryPoints: { cli: path.join(checkout.root, "packages/trust-shell/dist/src/cli.js") },
    // Only a checkout builds the Runner from sources; the distribution copies its packaged Runner.
    external: ["esbuild"],
    outdir: path.join(directory, "lib"),
  });
  await packageRunnerSkill(checkout, target.runnerSkillSource);
  await cp(checkout.operationsSkillSource, target.operationsSkillSource, { recursive: true });
  await mkdir(target.operationsDirectory, { recursive: true });
  for (const name of (await readdir(checkout.operationsDirectory)).filter((entry) => entry.endsWith(".feature")))
    await cp(path.join(checkout.operationsDirectory, name), path.join(target.operationsDirectory, name));
  await cp(
    path.join(runtimeRoot, "dist/documentation/catalog.json"),
    path.join(directory, "documentation/catalog.json"),
  );
  await cp(checkout.webDirectory, target.webDirectory, { recursive: true, filter: (source) => !isSourceMap(source) });

  const dependencies: Record<string, string> = {};
  for (const name of BUNDLED_DEPENDENCIES) {
    const source = dependencyDirectory(checkout.root, runtimeRoot, name);
    const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as { version: string };
    dependencies[name] = manifest.version;
    await cp(source, path.join(directory, "node_modules", name), {
      recursive: true,
      filter: (file) => !isSourceMap(file) && !/\.d\.[cm]?ts$/.test(file),
    });
  }
  await cp(path.join(checkout.root, "packages/trust-shell/README.md"), path.join(directory, "README.md"));
  await cp(path.join(checkout.root, "LICENSE"), path.join(directory, "LICENSE"));
  await mkdir(path.join(directory, "bin"), { recursive: true });
  await writeFile(path.join(directory, "bin/trust.js"), '#!/usr/bin/env node\n\nimport "../lib/cli.js";\n', {
    mode: 0o755,
  });
  const manifest = {
    name: NPM_PACKAGE_NAME,
    version: shellManifest.version,
    description: "TRUST server, web interface, Runner and agent skills in one command",
    license: "MIT",
    type: "module",
    engines: { node: shellManifest.engines.node },
    bin: { trust: "bin/trust.js" },
    files: ["bin", "lib", "web", "operations", "skills", "documentation"],
    dependencies,
    bundleDependencies: [...BUNDLED_DEPENDENCIES],
    publishConfig: { access: "public" },
  };
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, name: manifest.name, version: manifest.version };
}

function dependencyDirectory(checkoutRoot: string, from: string, name: string): string {
  for (let current = from; !path.relative(checkoutRoot, current).startsWith(".."); current = path.dirname(current)) {
    const candidate = path.join(current, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (current === checkoutRoot) break;
  }
  throw new Error(`Dependency ${name} is not installed in ${checkoutRoot}`);
}

function isSourceMap(file: string): boolean {
  return file.endsWith(".map");
}
