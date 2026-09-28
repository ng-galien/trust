import type { JsonValue } from "@trust/operation";
import {
  type CompiledOperation,
  evaluateOperationProjection,
  type Http,
  type OperationExecutionContext,
  operationProjectionContext,
  type Postgresql,
  renderHttpUrl,
  renderShellArgument,
  validateCompiledOperation,
  validateOperationEnvironment,
  validateOperationInput,
  validateOperationProduced,
} from "@trust/operation";
import { matchOperationStep } from "@trust/operation/match";
import { type DiagnosticsSink, now, nullSink, type StepReporter, summarizeValue } from "../diagnostics/events.js";
import { runFileRead } from "../file-read/run.js";
import { runHttp } from "../http/run.js";
import { isJsonObject, type JsonObject } from "../lib/json.js";
import { type PostgresqlRunnerConfiguration, runPostgresql } from "../postgresql/run.js";
import type { ShellRunnerConfiguration } from "../shell/run.js";
import { runShell } from "../shell/run.js";
import { type Clock, instantMilliseconds, SystemClock } from "../time.js";
import { DelegatedCredentials } from "./credentials.js";

export interface OperationResult {
  readonly steps: JsonObject;
  readonly produced: JsonObject;
}

export interface OperationRunnerConfiguration {
  /** Complete Operation budget resolved from the invoking Procedure Check. */
  readonly executionTimeoutMs?: number;
  readonly clock?: Clock;
  readonly shell?: ShellRunnerConfiguration;
  readonly postgresql?: PostgresqlRunnerConfiguration;
}

/** `credentials` holds the Credentials TRUST delegated for the admitted attempt; a trial or a
    dry-run delegates none. Step results, diagnostics and errors are masked before they leave a step,
    so later steps, Produce, Facts and actionOutcome never see a Credential value. */
export async function runOperation(
  operation: CompiledOperation,
  inputValue: unknown,
  environmentValue: unknown,
  sink: DiagnosticsSink = nullSink,
  executionValue: unknown = {},
  configuration: OperationRunnerConfiguration = {},
  delegatedCredentials: Readonly<Record<string, string>> = {},
): Promise<OperationResult> {
  const credentials = DelegatedCredentials.forOperation(operation, delegatedCredentials);
  try {
    return await executeOperation(
      operation,
      inputValue,
      environmentValue,
      credentials.sink(sink),
      executionValue,
      configuration,
      credentials,
    );
  } catch (error) {
    throw credentials.maskError(error);
  }
}

async function executeOperation(
  operation: CompiledOperation,
  inputValue: unknown,
  environmentValue: unknown,
  diagnostics: DiagnosticsSink,
  executionValue: unknown,
  configuration: OperationRunnerConfiguration,
  credentials: DelegatedCredentials,
): Promise<OperationResult> {
  const clock = configuration.clock ?? new SystemClock();
  const startedAt = instantMilliseconds(clock);
  const executionTimeoutMs = configuration.executionTimeoutMs;
  if (executionTimeoutMs !== undefined && (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1)) {
    throw new TypeError("executionTimeoutMs must be a positive integer");
  }
  diagnostics.emit({
    type: "operation.start",
    at: now(clock),
    operation: operation.operation,
    version: operation.version,
    stepCount: operation.steps.length,
  });
  try {
    validateCompiledOperation(operation);
    validateOperationInput(operation, inputValue);
    validateOperationEnvironment(operation, environmentValue);
    const input = jsonObject(inputValue, "Operation Input");
    const environment = jsonObject(environmentValue, "Operation Environment");
    const execution = operationExecution(executionValue);
    const steps: Record<string, JsonValue> = {};

    for (const [index, step] of operation.steps.entries()) {
      const reporter: StepReporter = {
        log: (stream, text) => diagnostics.emit({ type: "step.log", at: now(clock), step: step.name, stream, text }),
      };
      const stepStartedAt = instantMilliseconds(clock);
      diagnostics.emit({
        type: "step.start",
        at: now(clock),
        step: step.name,
        index,
        kind: step.type,
        ...describeStep(step, input, environment, execution),
      });
      try {
        const timeoutMs = remainingExecutionTime(executionTimeoutMs, startedAt, operation.operation, clock);
        const result = await matchOperationStep<Promise<unknown>>(step, {
          shell: ({ shell }) =>
            runShell(
              shell,
              input,
              environment,
              execution,
              reporter,
              {
                ...configuration.shell,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
              },
              (name) => credentials.resolve(name, `Shell step "${step.name}"`),
            ),
          "file-read": ({ file }) => runFileRead(file, input, environment, reporter),
          http: ({ http }) =>
            runHttp(http, input, environment, steps, execution, reporter, timeoutMs, clock, (name) =>
              credentials.resolve(name, `HTTP step "${step.name}"`),
            ),
          postgresql: ({ postgresql }) =>
            runPostgresql(
              postgresql,
              input,
              environment,
              reporter,
              {
                ...configuration.postgresql,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
              },
              (name) => credentials.resolve(name, `PostgreSQL step "${step.name}"`),
            ),
        });
        const converted = credentials.maskValue(json(result, `Operation step "${step.name}" result`));
        steps[step.name] = converted;
        diagnostics.emit({
          type: "step.end",
          at: now(clock),
          step: step.name,
          ok: true,
          durationMs: instantMilliseconds(clock) - stepStartedAt,
          outcome: outcomeOf(step, converted),
        });
      } catch (error) {
        diagnostics.emit({
          type: "step.end",
          at: now(clock),
          step: step.name,
          ok: false,
          durationMs: instantMilliseconds(clock) - stepStartedAt,
          outcome: {},
          error: message(error),
        });
        throw error;
      }
    }

    remainingExecutionTime(executionTimeoutMs, startedAt, operation.operation, clock);
    const producedValue = await evaluateOperationProjection(
      operation.produce.expression,
      operationProjectionContext(input, environment, steps, execution),
    );
    validateOperationProduced(operation, producedValue);
    const produced = jsonObject(producedValue, "Operation Produced values");
    diagnostics.emit({
      type: "operation.end",
      at: now(clock),
      ok: true,
      durationMs: instantMilliseconds(clock) - startedAt,
      produced,
      steps,
    });
    return { steps, produced };
  } catch (error) {
    diagnostics.emit({
      type: "operation.end",
      at: now(clock),
      ok: false,
      durationMs: instantMilliseconds(clock) - startedAt,
      error: message(error),
    });
    throw error;
  }
}

function remainingExecutionTime(
  timeoutMs: number | undefined,
  startedAt: number,
  operation: string,
  clock: Clock,
): number | undefined {
  if (timeoutMs === undefined) return undefined;
  const remaining = timeoutMs - (instantMilliseconds(clock) - startedAt);
  if (remaining < 1) throw new Error(`Operation "${operation}" exceeded its Check execution limit.`);
  return Math.max(1, Math.floor(remaining));
}

function describeStep(
  step: CompiledOperation["steps"][number],
  input: JsonObject,
  environment: JsonObject,
  execution: OperationExecutionContext,
): { summary: string; detail: JsonObject } {
  const resolve = (name: string): string => String(input[name] ?? `<${name}>`);
  return matchOperationStep<{ summary: string; detail: JsonObject }>(step, {
    shell: (step) => {
      const args = step.shell.arguments.map((argument) => renderShellArgument(argument, resolve, () => execution.id));
      return {
        summary: [step.shell.executable, ...args].join(" "),
        detail: {
          executable: step.shell.executable,
          arguments: args,
          cwd: describePath(step.shell.cwd, input, environment),
          acceptedExits: step.shell.acceptedExits.map((exit) => exit.code),
        },
      };
    },
    http: (step) => {
      const base = environment[step.http.url.environment];
      return {
        summary: `${step.http.method} ${typeof base === "string" ? renderedUrl(step.http, base, resolve, environment) : `<${step.http.url.environment}>`}`,
        detail: {
          method: step.http.method,
          environment: step.http.url.environment,
          ...(step.http.path.length ? { path: step.http.path.map((segment) => ({ ...segment })) } : {}),
          ...(step.http.query.length
            ? { query: step.http.query.map((parameter) => ({ ...parameter, source: { ...parameter.source } })) }
            : {}),
          ...(step.http.headers.length
            ? { headers: step.http.headers.map((header) => ({ ...header, source: { ...header.source } })) }
            : {}),
          ...(step.http.body === undefined
            ? {}
            : { body: { format: step.http.body.format, source: step.http.body.source } }),
          format: step.http.format,
        },
      };
    },
    postgresql: (step) => describePostgresql(step.postgresql),
    "file-read": (step) => ({
      summary: `read ${step.file.relativePath} (${step.file.format})`,
      detail: {
        relativePath: step.file.relativePath,
        root: describePath(step.file.root, input, environment),
        format: step.file.format,
      },
    }),
  });
}

function describePostgresql(postgresql: Postgresql): { summary: string; detail: JsonObject } {
  return {
    summary: `PostgreSQL Environment ${postgresql.connection.environment}`,
    detail: {
      environment: postgresql.connection.environment,
      inputParameter: "$1::jsonb",
      result: "one JSONB column named result",
    },
  };
}

/** Diagnostic only: a URL the step cannot render (a query on a base that already carries one) is reported by the step itself. */
function renderedUrl(http: Http, base: string, resolve: (name: string) => string, environment: JsonObject): string {
  try {
    return renderHttpUrl(http, base, resolve, (name) => String(environment[name] ?? `<${name}>`));
  } catch {
    return base;
  }
}

function describePath(
  path: { environment: string; appendInput?: string },
  input: JsonObject,
  environment: JsonObject,
): string | null {
  const root = environment[path.environment];
  if (typeof root !== "string") return null;
  if (path.appendInput === undefined) return root;
  const segment = input[path.appendInput];
  return `${root.replace(/\/$/, "")}/${typeof segment === "string" ? segment : `<${path.appendInput}>`}`;
}

function outcomeOf(step: CompiledOperation["steps"][number], result: JsonValue): JsonObject {
  if (!isJsonObject(result)) return {};
  return matchOperationStep<JsonObject>(step, {
    shell: () => ({
      exitCode: result.exitCode ?? null,
      stdoutBytes: typeof result.stdout === "string" ? result.stdout.length : 0,
      stderrBytes: typeof result.stderr === "string" ? result.stderr.length : 0,
    }),
    http: () => ({ status: result.status ?? null, bodyPreview: summarizeValue(result.body, 512) }),
    postgresql: () => ({ resultPreview: summarizeValue(result.result, 512) }),
    "file-read": () => ({
      relativePath: result.relativePath ?? null,
      contentPreview: summarizeValue(result.content, 512),
    }),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonObject(value: unknown, label: string): JsonObject {
  const converted = json(value, label);
  if (!isJsonObject(converted)) throw new TypeError(`${label} must be an object.`);
  return converted;
}

function operationExecution(value: unknown): OperationExecutionContext {
  const execution = jsonObject(value, "Operation Execution context");
  if (Object.keys(execution).length === 0) return { id: "" };
  if (Object.keys(execution).length !== 1 || typeof execution.id !== "string" || execution.id.length === 0) {
    throw new TypeError("Operation Execution context must contain exactly one non-empty id.");
  }
  return { id: execution.id };
}

function json(value: unknown, label: string): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${label} must be JSON.`);
  return JSON.parse(serialized) as JsonValue;
}
