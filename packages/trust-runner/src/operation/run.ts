import {
  validateCompiledOperation,
  validateOperationEnvironment,
  validateOperationInput,
  validateOperationProduced,
  type CompiledOperation,
} from "@trust/operation";

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
): Promise<OperationResult> {
  validateCompiledOperation(operation);
  validateOperationInput(operation, inputValue);
  validateOperationEnvironment(operation, environmentValue);
  const input = jsonObject(inputValue, "Operation Input");
  const environment = jsonObject(environmentValue, "Operation Environment");
  const steps: Record<string, JsonValue> = {};

  for (const step of operation.steps) {
    const result = step.type === "shell"
      ? await runShell(step.shell, input, environment)
      : step.type === "file-read"
        ? await runFileRead(step.file, environment)
        : await runHttp(step.http, input, environment);
    steps[step.name] = json(result, `Operation step "${step.name}" result`);
  }

  const producedValue = await transformJsonata(operation.produce.expression, {
    input,
    environment,
    steps,
  });
  validateOperationProduced(operation, producedValue);
  return {
    steps,
    produced: jsonObject(producedValue, "Operation Produced values"),
  };
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
