#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeEntry = resolve(repositoryRoot, "apps/trust-runtime/dist/src/index.js");
const runtimeOutput = resolve(repositoryRoot, "apps/trust-runtime/dist/src");
const skillPolicy = parseSkillPolicy(process.env.TRUST_SKILL_POLICY);
const principals = skillPolicy === "verified"
  ? await readFile(
      resolve(requiredEnvironment("TRUST_CONFIG_DIRECTORY"), "registry-principals.json"),
      "utf8",
    )
  : undefined;
const developmentMode = process.argv.includes("--dev");

if (developmentMode) {
  await runBuild();
}

const children = [];
if (developmentMode) {
  children.push(spawn(resolve(repositoryRoot, "node_modules/.bin/tsc"), [
    "-p",
    resolve(repositoryRoot, "apps/trust-runtime/tsconfig.json"),
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
  env: {
    ...process.env,
    TRUST_SKILL_POLICY: skillPolicy,
    ...(principals === undefined ? {} : { TRUST_REGISTRY_PRINCIPALS_JSON: principals.trim() }),
  },
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

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === "" || value.includes("\0")) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function parseSkillPolicy(value) {
  if (value === undefined || value === "" || value === "local") return "local";
  if (value === "verified") return "verified";
  throw new TypeError(`TRUST_SKILL_POLICY must be 'local' or 'verified', received '${value}'`);
}
