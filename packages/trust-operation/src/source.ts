import type { CompiledOperation, OperationStep, OperationValueDomain } from "./operation.js";
import type { SourceRange } from "@trust/gherkin";

export type { SourcePosition, SourceRange } from "@trust/gherkin";

export interface OperationEnvironmentSource {
  readonly name: string;
  readonly type: "directory" | "url" | "string";
  readonly range: SourceRange;
  readonly selectionRange: SourceRange;
}

export interface OperationInputSource {
  readonly name: string;
  readonly type: "string" | "number" | "instant" | "reference";
  readonly cardinality: "one" | "many";
  readonly range: SourceRange;
  readonly selectionRange: SourceRange;
}

export interface OperationStepSource {
  readonly name: string;
  readonly type: OperationStep["type"];
  readonly range: SourceRange;
  readonly selectionRange: SourceRange;
}

export interface OperationProducedSource {
  readonly name: string;
  readonly type: "string" | "number" | "instant" | "reference";
  readonly cardinality: "one" | "many";
  readonly domain: OperationValueDomain;
  readonly range: SourceRange;
  readonly selectionRange: SourceRange;
}

export interface OperationDocument {
  readonly kind: "operation";
  readonly operation?: string;
  readonly version?: string;
  readonly title: string;
  readonly description?: string;
  readonly range: SourceRange;
  readonly selectionRange: SourceRange;
  readonly environment: readonly OperationEnvironmentSource[];
  readonly input: readonly OperationInputSource[];
  readonly steps: readonly OperationStepSource[];
  readonly produced: readonly OperationProducedSource[];
}

export type OperationCompilationErrorCode =
  | "duplicate-environment"
  | "duplicate-input"
  | "duplicate-produced-field"
  | "duplicate-step"
  | "invalid-identifier"
  | "invalid-operation"
  | "secret-like-value"
  | "unknown-environment"
  | "unknown-step";

export interface OperationDiagnostic {
  readonly code: OperationCompilationErrorCode;
  readonly message: string;
  readonly sourceName: string;
  readonly range: SourceRange;
}

export type OperationAnalysis =
  | {
      readonly document: OperationDocument;
      readonly diagnostics: readonly [];
      readonly compiled: CompiledOperation;
    }
  | {
      readonly document?: OperationDocument;
      readonly diagnostics: readonly OperationDiagnostic[];
    };
