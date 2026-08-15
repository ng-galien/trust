import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compileOperation } from "@trust/operation";

import type { ConfiguredExecution } from "../application/execution-definition-service.js";
import type { RuntimeJsonObject } from "../domain/runtime-model.js";

export function readConfiguredExecutions(directory: string): readonly ConfiguredExecution[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".feature"))
    .sort()
    .map((name) => {
      const operation = compileOperation({
        source: readFileSync(resolve(directory, name), "utf8"),
        sourceName: name,
      });
      return { capability: operation.operation, operation };
    });
}

export function parseExecutionEnvironments(
  value: string | undefined,
): Readonly<Record<string, RuntimeJsonObject>> {
  if (value === undefined || value.trim() === "") return {};
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || Object.values(parsed).some((item) => !isRecord(item))) {
    throw new TypeError("TRUST_EXECUTION_ENVIRONMENTS_JSON must be an object of objects.");
  }
  return parsed as Readonly<Record<string, RuntimeJsonObject>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
