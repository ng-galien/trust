import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileOperation, type CompiledOperation, OperationCompilationError, validateOperationInput } from "@trust/operation";

import type { RuntimeJsonObject } from "../model.js";
import type { Clock } from "../time.js";
import type { EnvironmentService } from "../environment/service.js";
import type { TrialRecord, TrialRegistry, TrialSummary } from "./registry.js";

/* Starts trial runs: the same packaged runner an agent uses, spawned by TRUST, fed one job on stdin,
   its diagnostics streamed back through the diagnostic OTLP receiver. */

export type TrialErrorCode =
  | "unknown-operation"
  | "invalid-source"
  | "unknown-environment"
  | "incompatible-environment"
  | "invalid-input"
  | "runner-unavailable"
  | "unknown-trial";

export class TrialError extends Error {
  constructor(readonly reason: TrialErrorCode, message: string, readonly location?: { line: number; column: number }) {
    super(message);
    this.name = "TrialError";
  }
}

export interface TrialStartInput {
  readonly operation?: string;
  readonly version?: string;
  readonly source?: string;
  readonly environment: string;
  readonly input: RuntimeJsonObject;
  readonly startedBy: string;
}

export interface TrialServiceDependencies {
  readonly trialRegistry: TrialRegistry;
  readonly operations: readonly CompiledOperation[];
  readonly environmentService: EnvironmentService;
  readonly clock: Clock;
  readonly diagnosticsEndpoint: string;
  readonly runnerTrialScript: string;
  readonly trialTimeoutMs: number;
}

export const DEFAULT_TRIAL_TIMEOUT_MS = 5 * 60_000;
const FORCE_KILL_DELAY_MS = 2_000;

export class TrialService {
  readonly #registry: TrialRegistry;
  readonly #operations: readonly CompiledOperation[];
  readonly #environments: EnvironmentService;
  readonly #clock: Clock;
  readonly #diagnosticsEndpoint: string;
  readonly #script: string;
  readonly #timeoutMs: number;
  readonly #stop = new Map<string, (reason: string) => void>();

  constructor(dependencies: TrialServiceDependencies) {
    this.#registry = dependencies.trialRegistry;
    this.#operations = dependencies.operations;
    this.#environments = dependencies.environmentService;
    this.#clock = dependencies.clock;
    this.#diagnosticsEndpoint = dependencies.diagnosticsEndpoint;
    this.#script = dependencies.runnerTrialScript;
    if (!Number.isSafeInteger(dependencies.trialTimeoutMs) || dependencies.trialTimeoutMs <= 0) {
      throw new TypeError("trialTimeoutMs must be a positive integer");
    }
    this.#timeoutMs = dependencies.trialTimeoutMs;
  }

  environments(): Array<{ name: string; values: RuntimeJsonObject }> {
    return this.#environments.list();
  }

  /** For every catalog operation, which configured environments can run it. */
  catalogEnvironments(): Array<{ operation: string; version: string; environments: Array<{ name: string; compatible: boolean; missing: string[] }> }> {
    return this.#operations.map((operation) => {
      const needed = Object.keys((operation.environment as { properties?: Record<string, unknown> }).properties ?? {});
      return {
        operation: operation.operation,
        version: operation.version,
        environments: this.#environments.list().map(({ name, values }) => {
          const missing = needed.filter((key) => !(key in values));
          return { name, compatible: missing.length === 0, missing };
        }),
      };
    });
  }

  /** Environments qualified against one operation: compatible when every declared value is present. */
  environmentsFor(input: { operation?: string; version?: string; source?: string }): Array<{ name: string; values: RuntimeJsonObject; compatible: boolean; missing: string[] }> {
    const operation = this.#resolveOperation({ ...input, environment: "", input: {}, startedBy: "" });
    const needed = Object.keys((operation.environment as { properties?: Record<string, unknown> }).properties ?? {});
    return this.#environments.list().map(({ name, values }) => {
      const missing = needed.filter((key) => !(key in values));
      return { name, values, compatible: missing.length === 0, missing };
    });
  }

  start(input: TrialStartInput): TrialSummary {
    const operation = this.#resolveOperation(input);
    const environment = this.#environments.resolve(input.environment);
    if (!environment) throw new TrialError("unknown-environment", `Environment "${input.environment}" is not configured`);
    const missing = Object.keys((operation.environment as { properties?: Record<string, unknown> }).properties ?? {}).filter((key) => !(key in environment));
    if (missing.length) {
      throw new TrialError("incompatible-environment", `Environment "${input.environment}" does not declare ${missing.join(", ")} required by ${operation.operation}`);
    }
    try {
      validateOperationInput(operation, input.input);
    } catch (error) {
      throw new TrialError("invalid-input", error instanceof Error ? error.message : String(error));
    }
    if (!existsSync(this.#script)) {
      throw new TrialError("runner-unavailable", `Runner trial script is missing: ${this.#script} (run npm run package:skill)`);
    }

    const startedAt = this.#clock.now().toISOString();
    const trial = this.#registry.create({
      operation: operation.operation,
      version: operation.version,
      environment: input.environment,
      input: input.input,
      startedBy: input.startedBy,
      startedAt,
    });
    this.#registry.append(trial.id, { type: "trial.started", at: startedAt, operation: operation.operation, version: operation.version, environment: input.environment });
    // The compiled schema is closed: hand the runner only the values this operation declares.
    this.#spawn(trial, operation, declaredEnvironment(operation, environment));
    return summaryOf(this.#registry, trial.id);
  }

  read(id: string): TrialRecord {
    const trial = this.#registry.get(id);
    if (!trial) throw new TrialError("unknown-trial", `Trial "${id}" is unknown`);
    return trial;
  }

  list(operation?: string): TrialSummary[] {
    return this.#registry.list(operation);
  }

  cancel(id: string): TrialSummary {
    const trial = this.#registry.get(id);
    if (!trial) throw new TrialError("unknown-trial", `Trial "${id}" is unknown`);
    if (trial.status === "starting" || trial.status === "running") {
      this.#stop.get(id)?.("Trial cancelled by the operator.");
    }
    return summaryOf(this.#registry, id);
  }

  #resolveOperation(input: TrialStartInput): CompiledOperation {
    if (typeof input.source === "string") {
      try {
        return compileOperation({ source: input.source, sourceName: "trial.feature" });
      } catch (error) {
        if (error instanceof OperationCompilationError) {
          throw new TrialError("invalid-source", error.message, error.location);
        }
        throw error;
      }
    }
    const found = this.#operations.find((candidate) => candidate.operation === input.operation && (input.version === undefined || candidate.version === input.version));
    if (!found) throw new TrialError("unknown-operation", `Operation "${input.operation ?? ""}" is not in the catalog`);
    return found;
  }

  #spawn(trial: TrialRecord, operation: CompiledOperation, environment: RuntimeJsonObject): void {
    const child = spawn(process.execPath, [this.#script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TRUST_SHELL_TIMEOUT_MS: String(this.#timeoutMs),
        TRUST_RUNNER_PROCESS_GROUP: "1",
      },
      detached: process.platform !== "win32",
    });
    let forceKillTimer: NodeJS.Timeout | undefined;
    let stopReason: string | undefined;
    const stop = (reason: string): void => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      terminateProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
      this.#registry.append(trial.id, { type: "runner.log", at: this.#clock.now().toISOString(), level: "error", text: reason });
    };
    this.#stop.set(trial.id, stop);
    const timer = setTimeout(() => {
      stop(`Trial exceeded ${this.#timeoutMs / 1000}s and was stopped.`);
    }, this.#timeoutMs);
    timer.unref();
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#registry.append(trial.id, { type: "runner.log", at: this.#clock.now().toISOString(), level: "warn", text: chunk.trimEnd() });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      this.#stop.delete(trial.id);
      this.#registry.complete(trial.id, { status: "failed", endedAt: this.#clock.now().toISOString(), error: `Runner could not start: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (forceKillTimer && stopReason === undefined) clearTimeout(forceKillTimer);
      this.#stop.delete(trial.id);
      const endedAt = this.#clock.now().toISOString();
      if (stopReason !== undefined) {
        this.#registry.complete(trial.id, { status: "aborted", endedAt, error: stopReason });
        return;
      }
      const outcome = parseOutcome(stdout);
      if (outcome) {
        this.#registry.complete(trial.id, {
          status: outcome.ok === true ? "succeeded" : "failed",
          endedAt,
          outcome,
          ...(typeof outcome.error === "string" ? { error: outcome.error } : {}),
        });
        return;
      }
      this.#registry.complete(trial.id, {
        status: signal ? "aborted" : "failed",
        endedAt,
        error: signal ? `Runner stopped by ${signal}` : `Runner exited with code ${code ?? "unknown"} without an outcome`,
      });
    });
    const job = {
      contract: "trust.trial-job@1",
      trialId: trial.id,
      operation,
      input: trial.input,
      environment,
      diagnostics: { endpoint: this.#diagnosticsEndpoint },
    };
    child.stdin.end(JSON.stringify(job));
  }
}

function terminateProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

function declaredEnvironment(operation: CompiledOperation, environment: RuntimeJsonObject): RuntimeJsonObject {
  const declared = Object.keys((operation.environment as { properties?: Record<string, unknown> }).properties ?? {});
  return Object.fromEntries(declared.filter((key) => key in environment).map((key) => [key, environment[key]]));
}

function parseOutcome(stdout: string): RuntimeJsonObject | undefined {
  const line = stdout.trim().split("\n").reverse().find((candidate) => candidate.startsWith("{"));
  if (!line) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as RuntimeJsonObject).contract === "trust.trial-outcome@1"
      ? (parsed as RuntimeJsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function summaryOf(registry: TrialRegistry, id: string): TrialSummary {
  const summary = registry.list().find((trial) => trial.id === id);
  if (!summary) throw new TrialError("unknown-trial", `Trial "${id}" vanished`);
  return summary;
}

/** Default location of the packaged runner trial script, relative to this runtime package. */
export function defaultRunnerTrialScript(): string {
  const configured = process.env.TRUST_RUNNER_TRIAL_SCRIPT;
  if (configured) return configured;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../trust-runner/dist/skill/trust/scripts/trial.js");
}
