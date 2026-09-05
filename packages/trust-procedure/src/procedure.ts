import type { CompiledOperation, OperationValueType } from "@trust/operation";

export type ProcedureValueType = OperationValueType;

export type ProcedureCompilationErrorCode =
  | "invalid-procedure"
  | "invalid-identifier"
  | "unknown-operation"
  | "unknown-procedure"
  | "duplicate-invocation"
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
  /** Resolve a selected child against one immutable catalog snapshot before validating its binding. */
  readonly resolveProcedure?: (selected: CompiledProcedure) => CompiledProcedure;
  readonly source: string;
  readonly sourceName?: string;
  readonly operations: readonly CompiledOperation[];
  readonly procedures?: readonly CompiledProcedure[];
}

export interface ProcedureDiagnostic {
  readonly code: ProcedureCompilationErrorCode;
  readonly message: string;
  readonly sourceName: string;
  readonly location?: { readonly line: number; readonly column: number };
}

export interface ProcedureAnalysis {
  readonly compiled?: CompiledProcedure;
  readonly diagnostics: readonly ProcedureDiagnostic[];
}

/** 1-based position in the compiled `source`; presentational, excluded from the digest. */
export interface CompiledSourceLocation {
  readonly line: number;
  readonly column?: number;
}

export interface CompiledProcedureRole {
  readonly name: string;
  readonly type: ProcedureValueType;
  readonly cardinality: "one" | "many";
  readonly parents: readonly { readonly role: string; readonly each: boolean }[];
  /** Position of the declaring Background step; absent for synthesised roles. */
  readonly location?: CompiledSourceLocation;
  readonly source:
    | { readonly kind: "plan-input" }
    | { readonly kind: "agent-declaration"; readonly optional?: true }
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

export type JsonLogicRule =
  | null
  | boolean
  | number
  | string
  | readonly JsonLogicRule[]
  | { readonly [operator: string]: JsonLogicRule };

interface CompiledExpressionReferenceType {
  readonly valueType: ProcedureValueType;
  readonly cardinality: "one" | "many";
}

export type CompiledExpressionReference = CompiledExpressionReferenceType &
  (
    | { readonly kind: "fact"; readonly field: string }
    | { readonly kind: "context"; readonly role: string }
    | { readonly kind: "check"; readonly check: string; readonly field: string }
  );

export interface CompiledProcedureGuard {
  readonly conditionLogic: JsonLogicRule;
  readonly failureReasonLogic: JsonLogicRule;
  readonly references: readonly CompiledExpressionReference[];
}

export interface CompiledProcedureQualification {
  readonly source: string;
  readonly guards: readonly CompiledProcedureGuard[];
  readonly location: { readonly line: number; readonly column: number };
}

export interface CompiledProcedureCheck {
  readonly name: string;
  readonly scenario: string;
  readonly operation: string;
  readonly operationVersion: string;
  readonly operationSelector: string;
  readonly operationDigest: string;
  readonly target: { readonly role: string; readonly selection: "one" | "each" | "all" };
  readonly inputBindings: readonly CompiledProcedureInputBinding[];
  readonly materializes: readonly { readonly role: string; readonly field: string }[];
  readonly qualification: CompiledProcedureQualification;
  readonly successReason: string;
  /** Position of the Check step. */
  readonly location?: CompiledSourceLocation;
}

export interface CompiledProcedureScenario {
  readonly slug: string;
  readonly title: string;
  readonly dependencies: readonly string[];
  readonly checks: readonly string[];
  readonly invocations: readonly string[];
  /** Position of the Scenario line. */
  readonly location?: CompiledSourceLocation;
}

/** An immutable child Procedure dependency, instantiated as a separate Plan. */
export interface CompiledProcedureInvocation {
  readonly name: string;
  readonly scenario: string;
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly procedureSelector: string;
  readonly procedureDigest: string;
  readonly childDefinition: CompiledProcedure;
  readonly target?: CompiledProcedureCheck["target"];
  readonly inputBindings: readonly CompiledProcedureInputBinding[];
  readonly successReason: string;
  readonly location?: CompiledSourceLocation;
}

export interface CompiledProcedureOperation {
  readonly operation: string;
  readonly version: string;
  readonly digest: string;
  readonly definition: CompiledOperation;
}

/** One prose boundary declared by the Procedure. `all` applies to every Check; a Check name adds
    boundaries for that Check. The runner never interprets these declarations. */
export interface CompiledProcedureScope {
  readonly check: "all" | string;
  readonly authorized: string;
  readonly forbidden: string;
  readonly location?: CompiledSourceLocation;
}

export interface CompiledProcedure {
  readonly procedure: string;
  readonly version: string;
  readonly title: string;
  /** When enabled, every Plan engaged from this Procedure carries one rotating agent intent. */
  readonly intentChaining: boolean;
  /** Free-text description written under `Feature:`; absent when the source has none. Not part of the digest. */
  readonly description?: string;
  readonly source: string;
  readonly definitionDigest: string;
  readonly operations: readonly CompiledProcedureOperation[];
  readonly scope: readonly CompiledProcedureScope[];
  readonly roles: readonly CompiledProcedureRole[];
  readonly scenarios: readonly CompiledProcedureScenario[];
  readonly checks: readonly CompiledProcedureCheck[];
  readonly invocations: readonly CompiledProcedureInvocation[];
}
