import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { RegistryError } from "./error.js";

const BUILD_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT = 65_536;
const REPORTED_OUTPUT = 4_096;
/** The only variables a package build inherits: no TRUST_ variable, token, key or cloud credential. */
const BUILD_ENVIRONMENT = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT"] as const;

export function buildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of BUILD_ENVIRONMENT) if (process.env[name] !== undefined) environment[name] = process.env[name];
  environment.npm_config_update_notifier = "false";
  environment.npm_config_fund = "false";
  environment.npm_config_audit = "false";
  return environment;
}

/**
 * Build one extension directory that declares a `package.json`: install its declared dependencies (`npm ci`
 * with a lock file, `npm install` otherwise), then run its `build` script when present. Package scripts run with
 * the restricted environment above; any failure refuses the whole installation.
 */
export async function buildExtension(directory: string): Promise<readonly string[]> {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    throw new RegistryError(
      "build-failed",
      "The extension package.json is not valid JSON",
      undefined,
      undefined,
      "build",
    );
  }
  const declares = (key: string) => {
    const value = manifest[key];
    return typeof value === "object" && value !== null && Object.keys(value).length > 0;
  };
  const commands: string[][] = [];
  if (declares("dependencies") || declares("devDependencies")) {
    let locked = false;
    try {
      await readFile(join(directory, "package-lock.json"));
      locked = true;
    } catch {}
    commands.push(locked ? ["npm", "ci"] : ["npm", "install"]);
  }
  const scripts = manifest.scripts;
  if (typeof scripts === "object" && scripts !== null && typeof (scripts as Record<string, unknown>).build === "string")
    commands.push(["npm", "run", "build"]);
  let output = "";
  for (const [command = "npm", ...args] of commands) {
    output += `$ ${[command, ...args].join(" ")}\n`;
    const result = await run(command, args, directory);
    output = (output + result.output).slice(-OUTPUT_LIMIT);
    if (result.code !== 0)
      throw new RegistryError(
        "build-failed",
        `The extension build failed: ${[command, ...args].join(" ")} exited with ${result.code ?? result.signal}`,
        undefined,
        undefined,
        "build",
        output.slice(-REPORTED_OUTPUT),
      );
  }
  return commands.map((command) => command.join(" "));
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, { cwd, env: buildEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, signal: null, output: `${output}${error.message}\n` });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}
