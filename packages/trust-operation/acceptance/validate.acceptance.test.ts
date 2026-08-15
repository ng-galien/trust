import { readFileSync, readdirSync } from "node:fs";

import {
  compileOperation,
  OperationValidationError,
  validateOperationEnvironment,
  validateOperationInput,
  validateOperationProduced,
  type OperationValues,
} from "@trust/operation";
import { describe, expect, test } from "vitest";

const fixture = (path: string): string =>
  readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

const operation = compileOperation({
  source: fixture("valid/shell.context-read.feature"),
  sourceName: "shell.context-read.feature",
});

const invalidDirectory = new URL("./fixtures/values/invalid/", import.meta.url);
const invalidFiles = readdirSync(invalidDirectory).filter((name) => name.endsWith(".json")).sort();

interface InvalidFixture {
  readonly values: OperationValues;
  readonly value: unknown;
  readonly rules: readonly string[];
}

describe("compiled Operation schemas", () => {
  test("accept values matching Input, Environment and Produced fields", () => {
    const values = JSON.parse(fixture("values/valid/shell.context-read.json"));

    expect(() => validateOperationInput(operation, values.input)).not.toThrow();
    expect(() => validateOperationEnvironment(operation, values.environment)).not.toThrow();
    expect(() => validateOperationProduced(operation, values.produced)).not.toThrow();
  });

  test.each(invalidFiles)("rejects %s", (file) => {
    const invalid = JSON.parse(fixture(`values/invalid/${file}`)) as InvalidFixture;
    let thrown: unknown;

    try {
      validateValues(invalid.values, invalid.value);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OperationValidationError);
    expect(thrown).toMatchObject({
      values: invalid.values,
      issues: expect.arrayContaining(invalid.rules.map((rule) => expect.objectContaining({ rule }))),
    });
  });
});

function validateValues(values: OperationValues, value: unknown): void {
  if (values === "input") return validateOperationInput(operation, value);
  if (values === "environment") return validateOperationEnvironment(operation, value);
  validateOperationProduced(operation, value);
}
