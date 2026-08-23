import {
  evaluateOperationProjection,
  operationProjectionContext,
  renderHttpUrl,
  renderShellArgument,
  validateCompiledOperation,
  validateOperationEnvironment,
  validateOperationInput,
  validateOperationProduced,
  type CompiledOperation,
  type Http,
  type OperationExecutionContext,
} from "@trust/operation";

import { type DiagnosticsSink, now, nullSink, type StepReporter, summarizeValue } from "../diagnostics/events.js";
import { runFileRead } from "../file-read/run.js";
import { runHttp } from "../http/run.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../lib/json.js";
import { runShell } from "../shell/run.js";
import type { ShellRunnerConfiguration } from "../shell/run.js";

export interface OperationResult {
  readonly steps: JsonObject;
  readonly produced: JsonObject;
}

export interface OperationRunnerConfiguration {
  readonly shell?: ShellRunnerConfiguration;
}

export async function runOperation(
  operation: CompiledOperation,
  inputValue: unknown,
  environmentValue: unknown,
  diagnostics: DiagnosticsSink = nullSink,
  executionValue: unknown = {},
  configuration: OperationRunnerConfiguration = {},
): Promise<OperationResult> {
  const startedAt = Date.now();
  diagnostics.emit({ type: "operation.start", at: now(), operation: operation.operation, version: operation.version, stepCount: operation.steps.length });
  try {
    validateCompiledOperation(operation);
    validateOperationInput(operation, inputValue);
    validateOperationEnvironment(operation, environmentValue);
    const input = jsonObject(inputValue, "Operation Input");
    const environment = jsonObject(environmentValue, "Operation Environment");
    const execution = operationExecution(executionValue);
    const steps: Record<string, JsonValue> = {};

    for (const [index, step] of operation.steps.entries()) {
      const reporter: StepReporter = { log: (stream, text) => diagnostics.emit({ type: "step.log", at: now(), step: step.name, stream, text }) };
      const stepStartedAt = Date.now();
      diagnostics.emit({ type: "step.start", at: now(), step: step.name, index, kind: step.type, ...describeStep(step, input, environment, execution) });
      try {
        const result = step.type === "shell"
          ? await runShell(step.shell, input, environment, execution, reporter, configuration.shell)
          : step.type === "file-read"
            ? await runFileRead(step.file, input, environment, reporter)
            : await runHttp(step.http, input, environment, steps, execution, reporter);
        const converted = json(result, `Operation step "${step.name}" result`);
        steps[step.name] = converted;
        diagnostics.emit({ type: "step.end", at: now(), step: step.name, ok: true, durationMs: Date.now() - stepStartedAt, outcome: outcomeOf(step.type, converted) });
      } catch (error) {
        diagnostics.emit({ type: "step.end", at: now(), step: step.name, ok: false, durationMs: Date.now() - stepStartedAt, outcome: {}, error: message(error) });
        throw error;
      }
    }

    const producedValue = await evaluateOperationProjection(
      operation.produce.expression,
      operationProjectionContext(input, environment, steps, execution),
    );
    validateOperationProduced(operation, producedValue);
    const produced = jsonObject(producedValue, "Operation Produced values");
    diagnostics.emit({ type: "operation.end", at: now(), ok: true, durationMs: Date.now() - startedAt, produced, steps });
    return { steps, produced };
  } catch (error) {
    diagnostics.emit({ type: "operation.end", at: now(), ok: false, durationMs: Date.now() - startedAt, error: message(error) });
    throw error;
  }
}

function describeStep(step: CompiledOperation["steps"][number], input: JsonObject, environment: JsonObject, execution: OperationExecutionContext): { summary: string; detail: JsonObject } {
  const resolve = (name: string): string => String(input[name] ?? `<${name}>`);
  if (step.type === "shell") {
    const args = step.shell.arguments.map((argument) => renderShellArgument(argument, resolve, () => execution.id));
    return {
      summary: [step.shell.executable, ...args].join(" "),
      detail: { executable: step.shell.executable, arguments: args, cwd: describePath(step.shell.cwd, input, environment), acceptedExits: step.shell.acceptedExits.map((exit) => exit.code) },
    };
  }
  if (step.type === "http") {
    const base = environment[step.http.url.environment];
    return {
      summary: `${step.http.method} ${typeof base === "string" ? renderedUrl(step.http, base, resolve, environment) : `<${step.http.url.environment}>`}`,
      detail: {
        method: step.http.method,
        environment: step.http.url.environment,
        ...(step.http.path.length ? { path: step.http.path.map((segment) => ({ ...segment })) } : {}),
        ...(step.http.query.length ? { query: step.http.query.map((parameter) => ({ ...parameter, source: { ...parameter.source } })) } : {}),
        ...(step.http.headers.length ? { headers: step.http.headers.map((header) => ({ ...header, source: { ...header.source } })) } : {}),
        ...(step.http.body === undefined ? {} : { body: { format: step.http.body.format, source: step.http.body.source } }),
        format: step.http.format,
      },
    };
  }
  return {
    summary: `read ${step.file.relativePath} (${step.file.format})`,
    detail: { relativePath: step.file.relativePath, root: describePath(step.file.root, input, environment), format: step.file.format },
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

function describePath(path: { environment: string; appendInput?: string }, input: JsonObject, environment: JsonObject): string | null {
  const root = environment[path.environment];
  if (typeof root !== "string") return null;
  if (path.appendInput === undefined) return root;
  const segment = input[path.appendInput];
  return `${root.replace(/\/$/, "")}/${typeof segment === "string" ? segment : `<${path.appendInput}>`}`;
}

function outcomeOf(kind: string, result: JsonValue): JsonObject {
  if (!isJsonObject(result)) return {};
  if (kind === "shell") return { exitCode: result.exitCode ?? null, stdoutBytes: typeof result.stdout === "string" ? result.stdout.length : 0, stderrBytes: typeof result.stderr === "string" ? result.stderr.length : 0 };
  if (kind === "http") return { status: result.status ?? null, bodyPreview: summarizeValue(result.body, 512) };
  return { relativePath: result.relativePath ?? null, contentPreview: summarizeValue(result.content, 512) };
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
