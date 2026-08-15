import type { FileRead } from "./file-read.js";
import type { HttpGet } from "./http-get.js";
import type { Shell } from "./shell.js";

export type OperationValueType = "string" | "number" | "instant" | "reference";

export type OperationValueDomain =
  | { readonly kind: "any" }
  | { readonly kind: "enum"; readonly values: readonly string[] };

export interface InputField {
  readonly type: OperationValueType;
  readonly cardinality: "one" | "many";
}

export type EnvironmentValueType = "directory" | "url";

export interface EnvironmentField {
  readonly type: EnvironmentValueType;
}

export interface ProducedField {
  readonly type: OperationValueType;
  readonly cardinality: "one" | "many";
  readonly domain: OperationValueDomain;
}

export interface StringSchema {
  readonly type: "string";
  readonly format?: "date-time" | "trust-directory" | "trust-url";
  readonly minLength?: number;
  readonly enum?: readonly string[];
}

export interface NumberSchema {
  readonly type: "number";
}

export interface ArraySchema {
  readonly type: "array";
  readonly items: ValueSchema;
}

export type ValueSchema = StringSchema | NumberSchema | ArraySchema;

export interface ObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, ValueSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface Produce {
  readonly language: "jsonata";
  readonly expression: string;
}

export interface ShellStep {
  readonly name: string;
  readonly type: "shell";
  readonly shell: Shell;
}

export interface FileReadStep {
  readonly name: string;
  readonly type: "file-read";
  readonly file: FileRead;
}

export interface HttpStep {
  readonly name: string;
  readonly type: "http";
  readonly http: HttpGet;
}

export type OperationStep = ShellStep | FileReadStep | HttpStep;

export interface CompiledOperation {
  readonly contract: "trust.compiled-operation@1";
  readonly operation: string;
  readonly version: string;
  readonly title: string;
  readonly source: string;
  readonly input: ObjectSchema;
  readonly environment: ObjectSchema;
  readonly steps: readonly OperationStep[];
  readonly produce: Produce;
  readonly produced: ObjectSchema;
}
