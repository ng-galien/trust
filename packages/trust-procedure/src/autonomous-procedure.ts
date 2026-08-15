export type CompilationErrorCode =
  | "duplicate-capability"
  | "incomplete-capability"
  | "input-unbound"
  | "materialization-source-missing"
  | "unknown-action"
  | "unknown-output"
  | "unknown-observation"
  | "unknown-relation"
  | "implicit-synonym"
  | "dependency-cycle"
  | "target-produced-by-same-action"
  | "target-not-materialized"
  | "missing-failure-feedback"
  | "unknown-context-role"
  | "unknown-upstream-field"
  | "incompatible-relation-type"
  | "unknown-scenario-dependency"
  | "noncanonical-slug"
  | "missing-background"
  | "ambiguous-collection-target"
  | "incompatible-target-cardinality"
  | "ambiguous-collection-use"
  | "incompatible-use-cardinality"
  | "uncorrelated-member-context"
  | "unbound-output-scope"
  | "unbound-context-reference"
  | "fixed-role-output"
  | "duplicate-scenario-slug"
  | "ambiguous-output-provider"
  | "action-uri-segment-collision"
  | "duplicate-output-provider"
  | "invalid-authority"
  | "invalid-skill-action"
  | "invalid-identifier"
  | "invalid-procedure"
  | "secret-like-value"
  | "uri-collision";

export class ProcedureCompilationError extends Error {
  constructor(
    readonly code: CompilationErrorCode,
    message: string,
    readonly sourceName?: string,
    readonly location?: { line: number; column: number },
  ) {
    super(message);
    this.name = "ProcedureCompilationError";
  }
}

export type ActionContractValueType = "string" | "number" | "instant" | "reference";

export type ActionContractEffect =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "publish"
  | "transition"
  | "send"
  | "deploy";

export type ActionContractReplay = "replayable" | "human-intervention";

export interface AutonomousActionContractPortParent {
  readonly kind: "input" | "observation";
  readonly port: string;
}

export interface AutonomousActionContractInput {
  readonly type: ActionContractValueType;
  readonly cardinality: "one" | "many";
  readonly parents: readonly AutonomousActionContractPortParent[];
}

export type AutonomousActionContractDomain =
  | { readonly kind: "any" }
  | { readonly kind: "enum"; readonly values: readonly string[] };

export interface AutonomousActionContractObservation {
  readonly type: ActionContractValueType;
  readonly cardinality: "one" | "many";
  readonly domain: AutonomousActionContractDomain;
  readonly parents: readonly AutonomousActionContractPortParent[];
}

export interface AutonomousActionContractOutputParent {
  readonly kind: "input" | "output";
  readonly port: string;
}

export interface AutonomousActionContractOutput {
  readonly observation: string;
  readonly parents: readonly AutonomousActionContractOutputParent[];
}

export interface AutonomousActionContract {
  readonly effect: ActionContractEffect;
  readonly replay: ActionContractReplay;
  readonly inputs: Readonly<Record<string, AutonomousActionContractInput>>;
  readonly observations: Readonly<Record<string, AutonomousActionContractObservation>>;
  readonly outputs: Readonly<Record<string, AutonomousActionContractOutput>>;
}

export interface CompiledRequiredCapability {
  readonly capability: string;
  readonly contractCoreDigest: string;
  readonly actionContractDigest: string;
  readonly contract: AutonomousActionContract;
}

export interface AutonomousProcedureDefinitionCompilationInput {
  readonly source: string;
  readonly sourceName?: string;
}

export interface CompiledAutonomousInputBinding {
  readonly input: string;
  readonly role: string;
  readonly selection: "one" | "each" | "all";
}

export interface CompiledCapabilityCheckRef {
  readonly scenario: string;
  readonly capability: string;
  readonly target: CompiledTargetReference;
}

export interface CompiledAutonomousMaterializationParent {
  readonly kind: "input" | "output";
  readonly port: string;
  readonly role: string;
  readonly each: boolean;
}

export interface CompiledAutonomousMaterialization {
  readonly output: string;
  readonly role: string;
  readonly observation: string;
  readonly valueType: ActionContractValueType;
  readonly sourceCardinality: "one" | "many";
  readonly cardinality: "one" | "many";
  readonly parents: readonly CompiledAutonomousMaterializationParent[];
}

export type AutonomousRoleMaterialization =
  | { readonly kind: "plan-input" }
  | { readonly kind: "agent-declaration" }
  | { readonly kind: "static"; readonly value: string }
  | {
      readonly kind: "capability-output";
      readonly output: string;
      readonly providers: readonly CompiledCapabilityCheckRef[];
    };

export interface CompiledAutonomousResourceRole {
  readonly name: string;
  readonly cardinality: "one" | "many";
  readonly parents: readonly CompiledRoleParent[];
  readonly valueType: ActionContractValueType;
  readonly materialization: AutonomousRoleMaterialization;
}

export interface CompiledAutonomousScenarioDefinition {
  readonly slug: string;
  readonly title: string;
  readonly dependencies: readonly string[];
  readonly aggregation: "all-skill-actions";
  readonly checks: readonly CompiledCapabilityCheckRef[];
}

export type CompiledAutonomousExpectation =
  | {
      readonly kind: "literal";
      readonly token: string;
      readonly value: string | number;
      readonly valueType: "string" | "number";
      readonly cardinality: "one";
    }
  | {
      readonly kind: "valid-value";
      readonly token: "valid rfc3339";
      readonly codec: "rfc3339";
      readonly valueType: "instant";
      readonly cardinality: "one";
    }
  | {
      readonly kind: "context";
      readonly role: string;
      readonly valueType: ActionContractValueType;
      readonly cardinality: "one" | "many";
      readonly parents: readonly AutonomousActionContractPortParent[];
    }
  | {
      readonly kind: "check-observation";
      readonly check: string;
      readonly provider: CompiledCapabilityCheckRef;
      readonly observation: string;
      readonly valueType: ActionContractValueType;
      readonly cardinality: "one" | "many";
      readonly parents: readonly AutonomousActionContractPortParent[];
    };

export interface CompiledAutonomousQualificationPredicate {
  readonly observation: string;
  readonly observationType: ActionContractValueType;
  readonly observationCardinality: "one" | "many";
  readonly observationParents: readonly AutonomousActionContractPortParent[];
  readonly relation: "equals" | "at least" | "has at least" | "is in" | "before" | "after";
  readonly expectation: CompiledAutonomousExpectation;
  readonly failureFeedback: string;
}

export interface CompiledAutonomousCheck {
  readonly ref: CompiledCapabilityCheckRef;
  readonly capabilityContract: {
    readonly capability: string;
    readonly digest: string;
  };
  readonly compiledCheckDigest: string;
  readonly uriTemplate: {
    readonly procedure: string;
    readonly version: string;
    readonly scenario: string;
    readonly capabilitySegment: string;
    readonly target: CompiledTargetReference;
  };
  readonly name: string;
  readonly requiredCheckObservations: readonly string[];
  readonly inputBindings: readonly CompiledAutonomousInputBinding[];
  readonly materializes: readonly CompiledAutonomousMaterialization[];
  readonly successFeedback: string;
  readonly qualification: {
    readonly kind: "all";
    readonly predicates: readonly CompiledAutonomousQualificationPredicate[];
  };
}

export interface CompiledAutonomousProcedureDefinition {
  readonly contract: "trust.compiled-procedure@2";
  readonly procedure: string;
  readonly version: string;
  readonly title: string;
  readonly source: string;
  readonly definitionDigest: string;
  readonly requiredCapabilities: readonly CompiledRequiredCapability[];
  readonly roles: readonly CompiledAutonomousResourceRole[];
  readonly scenarios: readonly CompiledAutonomousScenarioDefinition[];
  readonly checkTemplates: readonly CompiledAutonomousCheck[];
}

export interface CompiledRoleParent {
  role: string;
  each: boolean;
}

export interface CompiledTargetUse {
  role: string;
  selection: "one" | "all";
}

export interface CompiledTargetReference {
  primary: {
    role: string;
    selection: "one" | "each" | "all";
  };
  using: readonly CompiledTargetUse[];
}
