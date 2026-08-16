import {
  validateCompiledOperation,
  validateOperationEnvironment,
  validateOperationInput,
  validateOperationProduced,
  type CompiledOperation,
} from "@trust/operation";

import { type DiagnosticsSink, now, nullSink, type StepReporter, summarizeValue } from "../diagnostics/events.js";
import { runFileRead } from "../file-read/run.js";
import { runHttp } from "../http/run.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../lib/json.js";
import { transformJsonata } from "../lib/jsonata.js";
import { runShell } from "../shell/run.js";

export interface OperationResult {
  readonly steps: JsonObject;
  readonly produced: JsonObject;
}

export async function runOperation(
  operation: CompiledOperation,
  inputValue: unknown,
  environmentValue: unknown,
  diagnostics: DiagnosticsSink = nullSink,
): Promise<OperationResult> {
  const startedAt = Date.now();
  diagnostics.emit({ type: "operation.start", at: now(), operation: operation.operation, version: operation.version, stepCount: operation.steps.length });
  try {
    validateCompiledOperation(operation);
    validateOperationInput(operation, inputValue);
    validateOperationEnvironment(operation, environmentValue);
    const input = jsonObject(inputValue, "Operation Input");
    const environment = jsonObject(environmentValue, "Operation Environment");
    const steps: Record<string, JsonValue> = {};

    for (const [index, step] of operation.steps.entries()) {
      const reporter: StepReporter = { log: (stream, text) => diagnostics.emit({ type: "step.log", at: now(), step: step.name, stream, text }) };
      const stepStartedAt = Date.now();
      diagnostics.emit({ type: "step.start", at: now(), step: step.name, index, kind: step.type, ...describeStep(step, input, environment) });
      try {
        const result = step.type === "shell"
          ? await runShell(step.shell, input, environment, reporter)
          : step.type === "file-read"
            ? await runFileRead(step.file, input, environment, reporter)
            : await runHttp(step.http, input, environment, reporter);
        const converted = json(result, `Operation step "${step.name}" result`);
        steps[step.name] = converted;
        diagnostics.emit({ type: "step.end", at: now(), step: step.name, ok: true, durationMs: Date.now() - stepStartedAt, outcome: outcomeOf(step.type, converted) });
      } catch (error) {
        diagnostics.emit({ type: "step.end", at: now(), step: step.name, ok: false, durationMs: Date.now() - stepStartedAt, outcome: {}, error: message(error) });
        throw error;
      }
    }

    const producedValue = await transformJsonata(operation.produce.expression, {
      input,
      environment,
      steps,
    });
    validateOperationProduced(operation, producedValue);
    const produced = jsonObject(producedValue, "Operation Produced values");
    diagnostics.emit({ type: "operation.end", at: now(), ok: true, durationMs: Date.now() - startedAt, produced, steps });
    return { steps, produced };
  } catch (error) {
    diagnostics.emit({ type: "operation.end", at: now(), ok: false, durationMs: Date.now() - startedAt, error: message(error) });
    throw error;
  }
}

function describeStep(step: CompiledOperation["steps"][number], input: JsonObject, environment: JsonObject): { summary: string; detail: JsonObject } {
  if (step.type === "shell") {
    const args = step.shell.arguments.map((argument) => (argument.kind === "literal" ? argument.value : String(input[argument.input] ?? `<${argument.input}>`)));
    return {
      summary: [step.shell.executable, ...args].join(" "),
      detail: { executable: step.shell.executable, arguments: args, cwd: describePath(step.shell.cwd, input, environment), acceptedExits: step.shell.acceptedExits.map((exit) => exit.code) },
    };
  }
  if (step.type === "http") {
    const base = environment[step.http.url.environment];
    const appended = step.http.appendInput ? input[step.http.appendInput] : undefined;
    return {
      summary: `${step.http.method} ${typeof base === "string" ? base : `<${step.http.url.environment}>`}${appended === undefined ? "" : `/${String(appended)}`}`,
      detail: { method: step.http.method, environment: step.http.url.environment, ...(step.http.appendInput ? { appendInput: step.http.appendInput } : {}), format: step.http.format },
    };
  }
  return {
    summary: `read ${step.file.relativePath} (${step.file.format})`,
    detail: { relativePath: step.file.relativePath, root: describePath(step.file.root, input, environment), format: step.file.format },
  };
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

function json(value: unknown, label: string): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${label} must be JSON.`);
  return JSON.parse(serialized) as JsonValue;
}
