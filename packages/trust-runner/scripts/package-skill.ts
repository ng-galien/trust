#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  packageRunnerSkill,
  trustInstallationAt,
} from "../../trust-shell/dist/src/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const arguments_ = process.argv.slice(2);
const output = outputDirectory(arguments_);

await packageRunnerSkill(trustInstallationAt(repositoryRoot), output, {
  replace: arguments_.length === 0,
});
process.stdout.write(`TRUST Skill packaged at ${output}\n`);

function outputDirectory(argv: readonly string[]): string {
  if (argv.length === 0) return path.join(packageRoot, "dist/skill/trust");
  if (argv.length !== 2 || argv[0] !== "--output" || argv[1]?.trim() === "") {
    throw new TypeError("usage: package-skill.ts [--output <directory>]");
  }
  if (!path.isAbsolute(argv[1]!)) throw new TypeError("Skill output directory must be absolute");
  return path.resolve(argv[1]!);
}
