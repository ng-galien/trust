import { compileOperation, type OperationCompilationInput } from "./compile.js";
import { evaluateOperationProjection, operationProjectionContext } from "./evaluate.js";
import type { JsonValue } from "./json.js";
import type { CompiledOperation } from "./operation.js";
import {
  validateOperationEnvironment,
  validateOperationInput,
  validateOperationProduced,
} from "./validate.js";

export interface OperationSimulationInput extends OperationCompilationInput {
  readonly input: unknown;
  readonly environment: unknown;
  readonly steps: unknown;
  readonly execution?: unknown;
}

export interface OperationSimulationResult {
  readonly contract: "trust.operation-simulation@1";
  readonly operation: CompiledOperation;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly environment: Readonly<Record<string, JsonValue>>;
  readonly steps: Readonly<Record<string, JsonValue>>;
  readonly produced: Readonly<Record<string, JsonValue>>;
}

export async function simulateOperation(
  input: OperationSimulationInput,
): Promise<OperationSimulationResult> {
  const operation = compileOperation(input);
  validateOperationInput(operation, input.input);
  validateOperationEnvironment(operation, input.environment);
  const operationInput = jsonObject(input.input, "Operation simulation Input");
  const environment = jsonObject(input.environment, "Operation simulation Environment");
  const steps = jsonObject(input.steps, "Operation simulation step results");
  const expectedSteps = operation.steps.map((step) => step.name).sort();
  const actualSteps = Object.keys(steps).sort();
  if (JSON.stringify(actualSteps) !== JSON.stringify(expectedSteps)) {
    throw new TypeError(
      `Operation simulation step results must contain exactly: ${expectedSteps.join(", ")}`,
    );
  }
  const producedValue = await evaluateOperationProjection(
    operation.produce.expression,
    operationProjectionContext(operationInput, environment, steps, input.execution ?? { id: "simulation" }),
  );
  validateOperationProduced(operation, producedValue);
  return {
    contract: "trust.operation-simulation@1",
    operation,
    input: operationInput,
    environment,
    steps,
    produced: jsonObject(producedValue, "Operation simulation Produced values"),
  };
}

function jsonObject(value: unknown, label: string): Readonly<Record<string, JsonValue>> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${label} must be JSON`);
  const parsed = JSON.parse(serialized) as JsonValue;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${label} must be an object`);
  }
  return parsed;
}
