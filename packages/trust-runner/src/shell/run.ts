import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";

import { renderShellArgument, type Shell } from "@trust/operation";

import { nullReporter, type StepReporter } from "../diagnostics/events.js";
import type { JsonObject } from "../lib/json.js";
import { DirectoryError, resolveEnvironmentDirectory } from "../lib/paths.js";

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

const DEFAULT_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 2_000;
/** Per-command timeout; hosts running long trials raise it through TRUST_SHELL_TIMEOUT_MS. */
const TIMEOUT_MS = Number.parseInt(process.env.TRUST_SHELL_TIMEOUT_MS ?? "", 10) > 0
  ? Number.parseInt(process.env.TRUST_SHELL_TIMEOUT_MS ?? "", 10)
  : DEFAULT_TIMEOUT_MS;
const MAX_OUTPUT_BYTES = 1_048_576;

export async function runShell(
  shell: Shell,
  input: JsonObject,
  environment: JsonObject,
  reporter: StepReporter = nullReporter,
): Promise<ShellResult> {
  let directory: string;
  try {
    ({ directory } = await resolveEnvironmentDirectory(shell.cwd, input, environment, `Shell "${shell.executable}"`));
  } catch (error) {
    if (error instanceof DirectoryError) throw new ShellError(error.message, { cause: error });
    throw error;
  }
  let processHandle: ReturnType<typeof spawn>;
  const ownsProcessGroup = process.platform !== "win32" && process.env.TRUST_RUNNER_PROCESS_GROUP !== "1";
  try {
    processHandle = spawn(shell.executable, shell.arguments.map((argument) => renderShellArgument(argument, (name) => {
      const value = input[name];
      if (typeof value !== "string") throw new ShellError(`Input "${name}" must be one string Shell argument.`);
      return value;
    })), {
      shell: false,
      cwd: directory,
      env: shellEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: ownsProcessGroup,
    });
  } catch (error) {
    if (error instanceof ShellError) throw error;
    throw new ShellError(`Cannot start Shell: ${shell.executable}.`, { cause: error });
  }

  let timedOut = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const requestStop = (): void => {
    terminateProcessTree(processHandle, "SIGTERM", ownsProcessGroup);
    if (forceKillTimer === undefined) {
      forceKillTimer = setTimeout(() => terminateProcessTree(processHandle, "SIGKILL", ownsProcessGroup), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    requestStop();
  }, TIMEOUT_MS);
  timer.unref();
  try {
    if (processHandle.stdout === null || processHandle.stderr === null) {
      throw new ShellError(`Shell output is unavailable: ${shell.executable}.`);
    }
    const [closed, stdout, stderr] = await Promise.all([
      once(processHandle, "close"),
      readBounded(processHandle.stdout, requestStop, (text) => reporter.log("stdout", text)),
      readBounded(processHandle.stderr, requestStop, (text) => reporter.log("stderr", text)),
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
    if (processHandle.exitCode === null && processHandle.signalCode === null) requestStop();
    else if (forceKillTimer) clearTimeout(forceKillTimer);
  }
}

function terminateProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals, ownsProcessGroup: boolean): void {
  if (child.pid === undefined) return;
  if (ownsProcessGroup) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

function shellEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith("TRUST_") || name === "JIRA_AUTHORIZATION") continue;
    environment[name] = value;
  }
  return environment;
}

async function readBounded(stream: Readable, abort: () => void, onChunk?: (text: string) => void): Promise<string> {
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
    onChunk?.(chunk.toString("utf8"));
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
