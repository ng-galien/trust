import jsonata from "jsonata";

import type { JsonValue } from "./json.js";
import { operationLanguage } from "./language.js";

/** Execute the compiled Operation projection through the single JSONata runtime boundary. */
export async function evaluateOperationProjection(expression: string, input: unknown): Promise<JsonValue> {
  const value = await jsonata(expression).evaluate(input);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("JSONata transformation must return JSON");
  return JSON.parse(serialized) as JsonValue;
}

export function operationProjectionContext(input: unknown, environment: unknown, steps: unknown): Record<string, unknown> {
  const [stepsRoot, inputRoot, environmentRoot] = operationLanguage.jsonata.roots;
  return { [inputRoot]: input, [environmentRoot]: environment, [stepsRoot]: steps };
}
