import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ErrorObject, Options, ValidateFunction } from "ajv";

import type { CompiledOperation, ObjectSchema } from "./operation.js";
import { compileOperation } from "./compile.js";

export type OperationValues = "input" | "environment" | "produced";

export interface OperationValidationIssue {
  readonly path: string;
  readonly rule: string;
  readonly message: string;
}

export class OperationValidationError extends Error {
  constructor(
    readonly values: OperationValues,
    readonly issues: readonly OperationValidationIssue[],
  ) {
    super(`${values} does not match the compiled Operation`);
    this.name = "OperationValidationError";
  }
}

export class CompiledOperationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompiledOperationValidationError";
  }
}

interface AjvCompiler {
  addFormat(name: string, format: { readonly type: "string"; readonly validate: (value: string) => boolean }): void;
  compile(schema: ObjectSchema): ValidateFunction;
}

type AjvConstructor = new (options: Options) => AjvCompiler;
type AddFormats = (ajv: AjvCompiler) => void;

const require = createRequire(import.meta.url);
const Ajv = (require("ajv/dist/2020.js") as { default: AjvConstructor }).default;
const addFormatsModule = require("ajv-formats") as { default?: AddFormats } | AddFormats;
const addFormats: AddFormats = typeof addFormatsModule === "function"
  ? addFormatsModule
  : addFormatsModule.default ?? (() => { throw new Error("ajv-formats does not expose a function"); });

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addFormat("trust-directory", {
  type: "string",
  validate: (value: string) => isAbsolute(value) && !value.includes("\0"),
});
ajv.addFormat("trust-url", {
  type: "string",
  validate: (value: string) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:")
        && url.username === ""
        && url.password === "";
    } catch {
      return false;
    }
  },
});

export function validateOperationInput(operation: CompiledOperation, value: unknown): void {
  validate("input", operation.input, value);
}

export function validateOperationEnvironment(operation: CompiledOperation, value: unknown): void {
  validate("environment", operation.environment, value);
}

export function validateOperationProduced(operation: CompiledOperation, value: unknown): void {
  validate("produced", operation.produced, value);
}

export function validateCompiledOperation(value: unknown): asserts value is CompiledOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompiledOperationValidationError("CompiledOperation must be an object");
  }
  const source = Reflect.get(value, "source");
  if (typeof source !== "string") {
    throw new CompiledOperationValidationError("CompiledOperation source must be a string");
  }

  let compiled: CompiledOperation;
  try {
    compiled = compileOperation({ source, sourceName: "CompiledOperation.source" });
  } catch (error) {
    throw new CompiledOperationValidationError(
      `CompiledOperation source is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isDeepStrictEqual(value, compiled)) {
    throw new CompiledOperationValidationError("CompiledOperation differs from its source");
  }
}

function validate(values: OperationValues, schema: ObjectSchema, value: unknown): void {
  const validator = ajv.compile(schema);
  if (validator(value)) return;
  throw new OperationValidationError(values, (validator.errors ?? []).map(issue));
}

function issue(error: ErrorObject): OperationValidationIssue {
  return {
    path: error.instancePath,
    rule: error.keyword,
    message: error.message ?? "invalid value",
  };
}
