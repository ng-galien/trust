import type {
  ActionContractValueType,
  AutonomousActionContract,
  CompiledAutonomousCheck,
  CompiledCapabilityCheckRef,
} from "@trust/procedure";
import type { SkillEnvelope } from "./skill-registry.js";

export type RuntimeJsonObject = Readonly<Record<string, unknown>>;

export interface Plan {
  slug: string;
  procedure: string;
  procedureVersion: string;
  environment: string;
  rootInputs: RuntimeJsonObject;
  currentRevision: number;
  createdAt: string;
}

export interface MaterializedCheck {
  uri: string;
  planSlug: string;
  planRevision: number;
  scenario: string;
  expansion: readonly string[];
  template: CompiledAutonomousCheck;
  compiledCheckDigest: string;
  /**
   * Exact currently-derived binding and upstream qualification context.
   * Absent only while a previously instantiated Check remains visible after
   * that context disappeared; such a Check stays OPEN but cannot be delegated.
   */
  currentContextDigest?: string;
  actionInput: RuntimeJsonObject;
  factContract: {
    contractVersion: "trust.action-contract@3";
    inputs: AutonomousActionContract["inputs"];
    outputs: AutonomousActionContract["outputs"];
    observations: AutonomousActionContract["observations"];
  };
  materializationContract: readonly MaterializationOutputContract[];
  scenarioDependencies: readonly string[];
  checkDependencies: readonly {
    checkName: string;
    providerCheckUri: string;
    observationDigest?: string;
  }[];
}

export interface MaterializationParentContract {
  kind: "input" | "output";
  port: string;
  role: string;
  each: boolean;
  valueType: ActionContractValueType;
}

/**
 * Closed public shape for one semantic role an admitted Check may materialize.
 * The Skill supplies one explicit incarnation at a time; collection cardinality
 * is expressed by repeating entries, never by positional arrays or zipping.
 */
export interface MaterializationOutputContract {
  output: string;
  observation: string;
  role: string;
  valueType: ActionContractValueType;
  sourceCardinality: "one" | "many";
  cardinality: "one" | "many";
  parents: readonly MaterializationParentContract[];
}

/** Capability-native grant exposed to a Skill; Feature roles never cross this boundary. */
export interface SkillMaterializationParentGrant {
  kind: "input" | "output";
  port: string;
  valueType: ActionContractValueType;
}

export interface SkillMaterializationOutputGrant {
  output: string;
  observation: string;
  valueType: ActionContractValueType;
  sourceCardinality: "one" | "many";
  parents: readonly SkillMaterializationParentGrant[];
}

export interface CorrelatedPortParentCoordinate {
  kind: "input" | "observation";
  port: string;
  value: unknown;
}

export interface CorrelatedPortValue {
  value: unknown;
  parents: readonly CorrelatedPortParentCoordinate[];
}

export interface MaterializedRoleIncarnation {
  output: string;
  role: string;
  value: unknown;
  parents: RuntimeJsonObject;
  provider: CompiledCapabilityCheckRef;
  providerCheckUri: string;
}

/**
 * Observation fields projected through one exact Product Action Contract
 * output and scoped to the exact compiled provider that produced them.
 */
export interface ValidatedOutputProjection {
  output: string;
  provider: CompiledCapabilityCheckRef;
  providerCheckUri: string;
  values: RuntimeJsonObject;
}

export interface ValidatedCheckObservationProjection {
  checkName: string;
  provider: CompiledCapabilityCheckRef;
  providerCheckUri: string;
  observations: RuntimeJsonObject;
}

export interface PlanMaterializationState {
  roleIncarnations: readonly MaterializedRoleIncarnation[];
  validatedOutputs: readonly ValidatedOutputProjection[];
  validatedCheckObservations: readonly ValidatedCheckObservationProjection[];
}

/**
 * Atomic, contract-validated interpretation of a Fact batch. Application code
 * may qualify it immediately, but must merge its materialization state only
 * after the Check verdict is VALIDATED.
 */
export interface ValidatedFactBatch {
  observations: RuntimeJsonObject;
  roleIncarnations: readonly MaterializedRoleIncarnation[];
  validatedOutputs: readonly ValidatedOutputProjection[];
  validatedCheckObservations: readonly ValidatedCheckObservationProjection[];
}

export interface MaterializedPlanRevision {
  procedure: string;
  procedureVersion: string;
  environment: string;
  rootInputs: RuntimeJsonObject;
  /** Current, Feature-authorized declarations written by the agent through MCP. */
  agentDeclarations: RuntimeJsonObject;
  /** Per-role activation identity; changes whenever that declaration role is replaced. */
  agentDeclarationActivations: Readonly<Record<string, string>>;
  planSlug: string;
  revision: number;
  definitionDigest: string;
  source: string;
  checks: readonly MaterializedCheck[];
  roleIncarnations: readonly MaterializedRoleIncarnation[];
  validatedOutputs: readonly ValidatedOutputProjection[];
  validatedCheckObservations: readonly ValidatedCheckObservationProjection[];
}

export type SessionState = "open" | "closed" | "expired";

export interface Session {
  id: string;
  planSlug: string;
  state: SessionState;
  openedAt: string;
  expiresAt: string;
  closedAt?: string;
}

export type ExecutionState = "pending" | "finalized";

/**
 * Immutable delegation resolved by TRUST for one Skill attempt. It correlates the
 * semantic Check with one exact deployment; it is not permission to mutate the
 * external system.
 */
export interface Execution {
  handle: string;
  attemptKey: string;
  planSlug: string;
  planRevision: number;
  checkUri: string;
  compiledCheckDigest: string;
  sessionId: string;
  capability: string;
  actionContractDigest: string;
  actionInput: RuntimeJsonObject;
  materializationContract: readonly MaterializationOutputContract[];
  releaseDigest: string;
  environment: string;
  deploymentKey: string;
  envelope: SkillEnvelope;
  runtimeIdentity: string;
  processIdentity: string;
  state: ExecutionState;
  grantedAt: string;
  expiresAt: string;
  finalizedAt?: string;
}

export interface Fact {
  id: string;
  executionHandle: string;
  checkUri: string;
  compiledCheckDigest: string;
  index: number;
  capability: string;
  actionContractDigest: string;
  observedAt: string;
  recordedAt: string;
  payload: RuntimeJsonObject;
}

export type CheckState = "open" | "satisfied";
export type ChecklistVerdict = "VALIDATED" | "NOT_VALIDATED";

export interface ChecklistDelta {
  newlySatisfied: readonly string[];
  newlyOpened: readonly string[];
  unchanged: readonly string[];
}

export interface CheckSnapshot {
  id: string;
  executionHandle: string;
  planSlug: string;
  planRevision: number;
  checkUri: string;
  compiledCheckDigest: string;
  state: CheckState;
  verdict: ChecklistVerdict;
  reasonCode: string;
  reason: string;
  factIds: readonly string[];
  checklistDelta: ChecklistDelta;
  calculatedAt: string;
}

/** The immutable Snapshot currently qualifying one Check in one Plan revision. */
export interface ActiveCheckQualification {
  planSlug: string;
  planRevision: number;
  checkUri: string;
  compiledCheckDigest: string;
  snapshotId: string;
  /** Changes on every new activation, even when an equivalent Snapshot is reused. */
  activationDigest: string;
}
