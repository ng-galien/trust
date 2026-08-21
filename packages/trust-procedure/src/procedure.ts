import type { CompiledOperation, OperationValueType } from "@trust/operation";

export type ProcedureValueType = OperationValueType;

export type ProcedureCompilationErrorCode =
  | "invalid-procedure"
  | "invalid-identifier"
  | "unknown-operation"
  | "unknown-role"
  | "unknown-input"
  | "unknown-field"
  | "duplicate-role"
  | "duplicate-check"
  | "duplicate-scenario"
  | "input-unbound"
  | "incompatible-type"
  | "incompatible-cardinality"
  | "invalid-dependency"
  | "dependency-cycle";

export class CatalogProcedureCompilationError extends Error {
  constructor(
    readonly code: ProcedureCompilationErrorCode,
    message: string,
    readonly sourceName?: string,
    readonly location?: { readonly line: number; readonly column: number },
  ) {
    super(message);
    this.name = "CatalogProcedureCompilationError";
  }
}

export interface ProcedureCompilationInput {
  readonly source: string;
  readonly sourceName?: string;
  readonly operations: readonly CompiledOperation[];
}

export interface CompiledProcedureRole {
  readonly name: string;
  readonly type: ProcedureValueType;
  readonly cardinality: "one" | "many";
  readonly parents: readonly { readonly role: string; readonly each: boolean }[];
  readonly source:
    | { readonly kind: "plan-input" }
    | { readonly kind: "agent-declaration" }
    | { readonly kind: "fixed"; readonly value: string }
    | { readonly kind: "operation-field"; readonly check: string; readonly field: string }
    /** The reserved role `plan`, synthesised when a Check uses `using plan as Input`: one string,
        the Plan identifier (slug) supplied at engagement, fixed for the Plan's lifetime. */
    | { readonly kind: "plan-identifier" };
}

/** An Operation Input bound from one role of the Plan context. */
export interface CompiledProcedureInputBinding {
  readonly input: string;
  readonly role: string;
  readonly selection: "one" | "each" | "all";
}

export type CompiledProcedureExpectation =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "valid-rfc3339" }
  | { readonly kind: "context"; readonly role: string }
  | { readonly kind: "check-field"; readonly check: string; readonly field: string };

export interface CompiledProcedurePredicate {
  readonly field: string;
  readonly relation: "equals" | "at least" | "has at least" | "is in" | "before" | "after";
  readonly expectation: CompiledProcedureExpectation;
  readonly failureReason: string;
}

export interface CompiledProcedureCheck {
  readonly name: string;
  readonly scenario: string;
  readonly operation: string;
  readonly operationVersion: string;
  readonly operationDigest: string;
  readonly target: { readonly role: string; readonly selection: "one" | "each" | "all" };
  readonly inputBindings: readonly CompiledProcedureInputBinding[];
  readonly materializes: readonly { readonly role: string; readonly field: string }[];
  readonly predicates: readonly CompiledProcedurePredicate[];
  readonly successReason: string;
}

export interface CompiledProcedureScenario {
  readonly slug: string;
  readonly title: string;
  readonly dependencies: readonly string[];
  readonly checks: readonly string[];
}

export interface CompiledProcedureOperation {
  readonly operation: string;
  readonly version: string;
  readonly digest: string;
  readonly definition: CompiledOperation;
}

export interface CompiledProcedure {
  readonly contract: "trust.compiled-procedure@3";
  readonly procedure: string;
  readonly version: string;
  readonly title: string;
  /** Free-text description written under `Feature:`; absent when the source has none. Not part of the digest. */
  readonly description?: string;
  readonly source: string;
  readonly definitionDigest: string;
  readonly operations: readonly CompiledProcedureOperation[];
  readonly roles: readonly CompiledProcedureRole[];
  readonly scenarios: readonly CompiledProcedureScenario[];
  readonly checks: readonly CompiledProcedureCheck[];
}
