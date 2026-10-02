#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trustInstallationAt } from "../dist/src/installation.js";
import { stageNpmPackage } from "../dist/src/npm-package.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [flag, output, ...rest] = process.argv.slice(2);
if (flag !== "--output" || output === undefined || rest.length > 0 || !path.isAbsolute(output)) {
  process.stderr.write("usage: package-npm.mjs --output <absolute-empty-directory>\n");
  process.exit(2);
}
const staged = await stageNpmPackage(trustInstallationAt(repositoryRoot), output);
process.stdout.write(`${staged.name}@${staged.version} staged at ${staged.directory}\n`);
