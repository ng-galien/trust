#!/usr/bin/env node
// Runs the quality gate a project declares in its own package scripts: each script the gate names runs with
// `npm run <script>` at the root of that project, a directory directly below the workspace where the projects live.
// Reports it on four lines: gate, passed (1 or 0), findings (failed scripts), one-line summary. It always exits 0
// once its arguments are valid so the Runner records the observation.
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
/** All scripts of one gate together stay below the Runner's default Shell timeout (600 s). */
const BUDGET_MS = 540000;
const SCRIPT = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const line = (value) =>
  [...String(value)].map((character) => (character.charCodeAt(0) < 32 ? " " : character)).join("");

const runIn = (directory, command, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: directory, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk) => {
      if (output.length < 4 * 1024 * 1024) output += chunk;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(error.message) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? -1 : code, output });
    });
  });

/** `gate` is one or more package script names separated by spaces, for example "typecheck lint". */
export async function runGate(workspace, project, gate) {
  if (!PROJECT.test(project ?? "") || project === "..")
    throw new Error("Project must name one directory directly below the workspace");
  const scripts = String(gate ?? "").split(" ");
  if (
    scripts.length > 16 ||
    !scripts.every((script) => SCRIPT.test(script)) ||
    new Set(scripts).size !== scripts.length
  )
    throw new Error("Gate must name 1 to 16 distinct package scripts separated by spaces");
  const root = path.join(await realpath(workspace), project);
  const stat = await lstat(root).catch(() => undefined);
  if (!stat?.isDirectory() || (await realpath(root)) !== root)
    throw new Error(`Project "${project}" is not a directory directly below the workspace`);
  let declared = {};
  try {
    declared = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts ?? {};
  } catch {}
  const undeclared = scripts.filter((script) => typeof declared[script] !== "string");
  if (undeclared.length)
    return {
      gate,
      passed: 0,
      findings: undeclared.length,
      summary: `project ${project} declares no package script ${undeclared.join(", ")}`,
    };
  const deadline = Date.now() + BUDGET_MS;
  const failed = [];
  for (const script of scripts) {
    const remaining = deadline - Date.now();
    const result =
      remaining > 0
        ? await runIn(root, "npm", ["run", "--silent", script], remaining)
        : { code: -1, output: "gate budget exhausted" };
    if (result.code !== 0) {
      process.stderr.write(result.output.slice(-8000));
      const detail = result.output.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
      failed.push(`npm run ${script} exited with ${result.code}${detail ? ` (${detail})` : ""}`);
    }
  }
  return {
    gate,
    passed: failed.length === 0 ? 1 : 0,
    findings: failed.length,
    summary: failed.length
      ? `project ${project} failed: ${failed.join("; ")}`
      : `project ${project} passed npm run ${scripts.join(", npm run ")}`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [project, gate, ...rest] = process.argv.slice(2);
  try {
    if (!project || !gate || rest.length) throw new Error("Usage: workspace-script-gate.mjs <project> <gate>");
    const result = await runGate(process.cwd(), project, gate);
    console.log([result.gate, result.passed, result.findings, line(result.summary)].join("\n"));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
