import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compileOperation, type CompiledOperation } from "@trust/operation";

import type { RuntimeJsonObject } from "./model.js";

export function readOperations(directory: string): readonly CompiledOperation[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".feature"))
    .sort()
    .map((name) => compileOperation({
      source: readFileSync(resolve(directory, name), "utf8"),
      sourceName: name,
    }));
}

export function parseEnvironments(
  value: string | undefined,
): Readonly<Record<string, RuntimeJsonObject>> {
  if (value === undefined || value.trim() === "") return {};
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || Object.values(parsed).some((item) => !isRecord(item))) {
    throw new TypeError("TRUST_ENVIRONMENTS_JSON must be an object of objects.");
  }
  return parsed as Readonly<Record<string, RuntimeJsonObject>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
