#!/usr/bin/env node

import { build } from "esbuild";
import { cp, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const skillSource = path.join(repositoryRoot, "assets/skills/trust");
const arguments_ = process.argv.slice(2);
const output = outputDirectory(arguments_);

if (arguments_.length === 0) {
  await rm(output, { recursive: true, force: true });
} else if (await exists(output)) {
  throw new TypeError("Custom Skill output directory must not already exist");
}
await mkdir(path.join(output, "scripts"), { recursive: true });
await Promise.all([
  cp(path.join(skillSource, "SKILL.md"), path.join(output, "SKILL.md")),
  cp(path.join(skillSource, "agents"), path.join(output, "agents"), { recursive: true }),
  cp(path.join(skillSource, "references"), path.join(output, "references"), { recursive: true }),
]);

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: {
    run: path.join(packageRoot, "scripts/run.ts"),
    "mcp-stdio": path.join(packageRoot, "scripts/mcp-stdio.ts"),
    trial: path.join(packageRoot, "scripts/trial.ts"),
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

process.stdout.write(`TRUST Skill packaged at ${output}\n`);

function outputDirectory(argv: readonly string[]): string {
  if (argv.length === 0) return path.join(packageRoot, "dist/skill/trust");
  if (argv.length !== 2 || argv[0] !== "--output" || argv[1]?.trim() === "") {
    throw new TypeError("usage: package-skill.ts [--output <directory>]");
  }
  const resolved = path.resolve(argv[1]!);
  if (resolved === path.parse(resolved).root || resolved === skillSource) {
    throw new TypeError("Skill output directory is unsafe");
  }
  return resolved;
}

async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
