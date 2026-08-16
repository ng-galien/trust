#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeEntry = resolve(repositoryRoot, "packages/trust-runtime/dist/src/index.js");
const runtimeOutput = resolve(repositoryRoot, "packages/trust-runtime/dist/src");
const developmentMode = process.argv.includes("--dev");

if (developmentMode) {
  await runBuild();
}

const children = [];
if (developmentMode) {
  children.push(spawn(resolve(repositoryRoot, "node_modules/.bin/tsc"), [
    "-p",
    resolve(repositoryRoot, "packages/trust-runtime/tsconfig.json"),
    "--watch",
    "--preserveWatchOutput",
  ], {
    cwd: repositoryRoot,
    stdio: "inherit",
  }));
}
const child = spawn(process.execPath, [
  ...(developmentMode ? [`--watch-path=${runtimeOutput}`, "--watch-preserve-output"] : []),
  runtimeEntry,
], {
  env: process.env,
  stdio: "inherit",
});
children.push(child);
child.once("error", (error) => {
  process.stderr.write(`TRUST server failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 128);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const process of children) process.kill(signal);
  });
}

async function runBuild() {
  await new Promise((resolveBuild, rejectBuild) => {
    const build = spawn("npm", ["run", "build", "--workspace", "@trust/runtime"], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    build.once("error", rejectBuild);
    build.once("exit", (code, signal) => {
      if (code === 0) {
        resolveBuild();
        return;
      }
      rejectBuild(new Error(`runtime build failed: ${code ?? signal ?? "unknown"}`));
    });
  });
}
