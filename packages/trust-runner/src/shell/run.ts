import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import type { Readable } from "node:stream";

import type { Shell } from "@trust/operation";

import type { JsonObject } from "../lib/json.js";

export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class ShellError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShellError";
  }
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export async function runShell(
  shell: Shell,
  input: JsonObject,
  environment: JsonObject,
): Promise<ShellResult> {
  const directoryValue = environment[shell.cwd.environment];
  if (typeof directoryValue !== "string") {
    throw new ShellError(`Environment "${shell.cwd.environment}" must be a directory.`);
  }
  const directory = await realpath(directoryValue);
  let processHandle: ReturnType<typeof spawn>;
  try {
    processHandle = spawn(shell.executable, shell.arguments.map((argument) => {
      if (argument.kind === "literal") return argument.value;
      const value = input[argument.input];
      if (typeof value !== "string") {
        throw new ShellError(`Input "${argument.input}" must be one string Shell argument.`);
      }
      return value;
    }), {
      shell: false,
      cwd: directory,
      env: shellEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error instanceof ShellError) throw error;
    throw new ShellError(`Cannot start Shell: ${shell.executable}.`, { cause: error });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    processHandle.kill("SIGTERM");
  }, TIMEOUT_MS);
  try {
    if (processHandle.stdout === null || processHandle.stderr === null) {
      throw new ShellError(`Shell output is unavailable: ${shell.executable}.`);
    }
    const [closed, stdout, stderr] = await Promise.all([
      once(processHandle, "close"),
      readBounded(processHandle.stdout, () => processHandle.kill("SIGTERM")),
      readBounded(processHandle.stderr, () => processHandle.kill("SIGTERM")),
    ]);
    if (timedOut) throw new ShellError(`Shell timed out: ${shell.executable}.`);
    const exitCode = closed[0];
    if (typeof exitCode !== "number") {
      throw new ShellError(`Shell ended without an exit code: ${shell.executable}.`);
    }
    const accepted = shell.acceptedExits.some((expected) =>
      expected.code === exitCode
      && (expected.stdoutContains === undefined || stdout.includes(expected.stdoutContains))
      && (expected.stderrContains === undefined || stderr.includes(expected.stderrContains))
    );
    if (!accepted) {
      const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
      throw new ShellError(`Shell "${shell.executable}" returned an unexpected exit: ${detail}`);
    }
    return Object.freeze({ exitCode, stdout, stderr });
  } catch (error) {
    if (error instanceof ShellError) throw error;
    throw new ShellError(`Shell failed: ${shell.executable}.`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function shellEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith("TRUST_") || name === "JIRA_AUTHORIZATION") continue;
    environment[name] = value;
  }
  return environment;
}

async function readBounded(stream: Readable, abort: () => void): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    size += chunk.byteLength;
    if (size > MAX_OUTPUT_BYTES) {
      abort();
      throw new ShellError(`Shell output exceeds ${MAX_OUTPUT_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
