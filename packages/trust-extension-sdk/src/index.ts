/** Public extension and client contracts. No runtime implementation dependency. */

export type { CatalogMetadata, CatalogMetadataUpdate } from "./catalog.js";

export type {
  ExtensionContext,
  ExtensionDescriptor,
  ExtensionFactory,
  ExtensionLifecycle,
  ExtensionPageProps,
  ExtensionState,
} from "./extension.js";
export type {
  SourceTemplate,
  TemplateDocumentContext,
  TemplateParameter,
  TemplatePlaceholder,
  TemplateRenderRequest,
  TemplateRenderResult,
  TemplateSaveRequest,
} from "./templates.js";
export interface NextCheck {
  readonly name: string;
  readonly successReason: string;
  readonly checkUri: string;
  readonly actionScope: {
    readonly authorized: readonly string[];
    readonly forbidden: readonly string[];
  };
}

export type CheckContinuation =
  | { readonly action: "RUN_CHECKS"; readonly checks: readonly NextCheck[] }
  | { readonly action: "RETRY_OR_ESCALATE"; readonly checks: readonly NextCheck[] }
  | { readonly action: "COMPLETE" }
  | { readonly action: "READ_PLAN" };

/** Public RPC/runner result: qualification plus the next governed action. */
export type CheckFinalizationResult = AttemptFinalizationResult & { readonly next: CheckContinuation };
export type PlanEventType =
  | "plan.engaged"
  | "plan.revision"
  | "plan.state"
  | "plan.removed"
  | "session.changed"
  | "runtime.changed";

export interface PlanEvent {
  readonly sequence: number;
  readonly id: string;
  readonly type: PlanEventType;
  readonly at: string;
  readonly plan?: string;
  readonly resync?: true;
  readonly revision?: number;
  readonly cause?: "declarations" | "verdict";
  readonly workState?: "IN_PROGRESS" | "ESCALATED" | "COMPLETE";
  readonly checklistDelta?: {
    readonly newlySatisfied: readonly string[];
    readonly newlyOpened: readonly string[];
    readonly unchanged: readonly string[];
  };
  readonly removedCheckUris?: readonly string[];
  readonly session?: { readonly id: string; readonly state: "open" | "closed" | "expired" };
}
export interface Installation {
  id: string;
  title: string;
  version: string;
  server: string;
  configuration: Record<string, string>;
  environment: string;
  grants: string[];
  credentialEnvironment: string[];
  autoStart: boolean;
  ui?: { name: string; entry: string; module: string; assets: string };
  mcp?: { description: string; commands: CommandDeclaration[] };
}

export interface CommandDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

import type { CompiledProcedure } from "@trust/procedure";

export interface PlanParentView {
  plan: string;
  invocationId: string;
  generation: number;
  current: boolean;
}
export interface AttemptQualification {
  readonly verdict: ChecklistVerdict;
  readonly reasonCode: string;
  readonly reason: string;
  readonly checklistDelta: ChecklistDelta;
}

export type RuntimeJsonObject = Readonly<Record<string, unknown>>;

export interface PlanMetadata {
  readonly title?: string;
  readonly labels: readonly string[];
  readonly annotations: Readonly<Record<string, string>>;
}

/** A dry-run Plan follows every rule of a live Plan, but its Checks are qualified from Facts
    supplied by the operator instead of the runner: no environment is ever resolved for it. */
export type PlanMode = "live" | "dry-run";
export type IntentChainState = "DISABLED" | "NOT_STARTED" | "ACTIVE" | "COMPLETE";

export interface PlanListInput {
  readonly filter?: { readonly procedure?: string; readonly mode?: PlanMode };
  readonly cursor?: string;
  readonly limit?: number;
}

export interface HistoryListInput {
  readonly filter?: {
    readonly plan?: string;
    readonly procedure?: string;
    readonly mode?: PlanMode;
    readonly verdict?: ChecklistVerdict;
    readonly since?: string;
    readonly until?: string;
  };
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ProcedureReadInput {
  readonly checkUri: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ProcedureReadView {
  readonly source: string;
  readonly nextCursor?: string;
}

export interface PlanView {
  readonly descendantEscalations: readonly DescendantEscalation[];
  readonly invocations: readonly InvocationView[];
  readonly parent: PlanParentView | null;
  readonly plan: string;
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly environment: string;
  readonly mode: PlanMode;
  readonly intentChaining: boolean;
  readonly intentChainState: IntentChainState;
  readonly currentIntent: string | null;
  readonly nextIntent: string | null;
  readonly currentIntentCheckUri: string | null;
  readonly metadata: PlanMetadata;
  readonly rootInputs: Readonly<Record<string, unknown>>;
  readonly importedResults: readonly PlanImportedResult[];
  readonly createdAt: string;
  readonly state: "ENGAGED";
  readonly sessionState: "OPEN" | "UNAVAILABLE";
  readonly workState: "IN_PROGRESS" | "ESCALATED" | "COMPLETE";
  readonly revision: number;
  readonly declarations: Readonly<Record<string, unknown>>;
  readonly missionDeclarations?: MissionDeclarations;
  readonly missionCollections?: import("@trust/procedure").CompiledProcedure["missionCollections"];
  readonly resolvedMissions?: ResolvedMissions;
  readonly declarationRoles: readonly {
    readonly role: string;
    readonly type: string;
    readonly cardinality: string;
    readonly optional: boolean;
    readonly parents: readonly { readonly role: string; readonly each: boolean }[];
  }[];
  readonly missingDeclarations: readonly string[];
  readonly checklistComplete: boolean;
  readonly satisfiedChecks: number;
  readonly openChecks: readonly string[];
  readonly actionableChecks: readonly string[];
  readonly blockedChecks: readonly string[];
  readonly checks: readonly PlanCheckView[];
  readonly latestRevisionChange: {
    readonly fromRevision: number | null;
    readonly toRevision: number;
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly newlySatisfied: readonly string[];
    readonly newlyOpened: readonly string[];
    readonly changed: readonly string[];
    readonly unchanged: readonly string[];
  };
  readonly latestQualification: {
    readonly checkUri: string;
    readonly attemptHandle: string;
    readonly executionId: string;
    readonly verdict: "VALIDATED" | "NOT_VALIDATED";
    readonly reasonCode: string;
    readonly reason: string;
    readonly newlySatisfied: readonly string[];
    readonly newlyOpened: readonly string[];
    readonly unchanged: readonly string[];
  } | null;
  readonly activeEscalation: PlanEscalationView | null;
  readonly escalations: readonly PlanEscalationView[];
  readonly revisions: readonly PlanRevisionView[];
  readonly sessions: readonly SessionRecordView[];
}

/** Read-only episode assembled from the current Plan, its Checks, and accepted child missions.
    The source views retain their own revision, Fact, and qualification provenance. */
export interface DelegationEpisodeView {
  readonly contract: "trust.delegation-episode@1";
  readonly root: DelegationEpisodePlanView;
  readonly branches: readonly {
    readonly invocation: InvocationView;
    readonly child: DelegationEpisodePlanView | null;
  }[];
}

export interface DelegationEpisodePlanView {
  readonly plan: PlanView;
  readonly checks: readonly CheckView[];
}

export interface PlanSummaryView {
  readonly descendantEscalations: readonly DescendantEscalation[];
  readonly parent: PlanParentView | null;
  readonly plan: string;
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly environment: string;
  readonly mode: PlanMode;
  readonly intentChaining: boolean;
  readonly intentChainState: IntentChainState;
  readonly currentIntent: string | null;
  readonly nextIntent: string | null;
  readonly currentIntentCheckUri: string | null;
  readonly metadata: PlanMetadata;
  readonly revision: number;
  readonly createdAt: string;
  readonly sessionState: "OPEN" | "UNAVAILABLE";
  readonly workState: "IN_PROGRESS" | "ESCALATED" | "COMPLETE";
  readonly satisfiedChecks: number;
  readonly checkCount: number;
}

export interface HistoryView {
  readonly snapshotId: string;
  readonly calculatedAt: string;
  readonly plan: string;
  readonly mode: PlanMode;
  readonly procedure: string;
  readonly checkUri: string;
  readonly checkName: string;
  readonly target: CheckTargetView;
  readonly operation: string;
  readonly attemptHandle: string;
  readonly verdict: ChecklistVerdict;
  readonly reasonCode: string;
  readonly reason: string;
  readonly factCount: number;
  readonly checklistDelta: ChecklistDelta;
}

export interface PlanRevisionView {
  readonly revision: number;
  readonly definitionDigest: string;
  readonly source: string;
  readonly declarations: Readonly<Record<string, unknown>>;
  readonly missionDeclarations?: MissionDeclarations;
  readonly resolvedMissions?: ResolvedMissions;
  readonly roleValues: readonly unknown[];
  readonly importedResults: readonly PlanImportedResult[];
  readonly checkValues: readonly unknown[];
  readonly checkUris: readonly string[];
}

/** A current child Result projected into a parent Plan, with generation provenance. */
export interface PlanImportedResult {
  readonly role: string;
  readonly result: string;
  readonly value: unknown;
  readonly parents: RuntimeJsonObject;
  readonly invocationId: string;
  readonly childPlan: string;
  readonly childRevision: number;
}

export interface PlanEscalationView {
  readonly escalationId: string;
  readonly planRevision: number;
  readonly snapshotPlanRevision: number;
  readonly checkUri: string;
  readonly snapshotId: string;
  readonly attemptHandle: string;
  readonly blockingReason: string;
  readonly forbiddenFurtherAction: string;
  readonly escalatedAt: string;
  readonly resumedAt: string | null;
  readonly resumeReason: string | null;
}

export interface SessionRecordView {
  readonly id: string;
  readonly state: "open" | "closed" | "expired";
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly closedAt?: string;
}

export interface PlanCheckView {
  readonly checkUri: string;
  readonly name: string;
  readonly successReason: string;
  readonly scenario: string;
  readonly target: CheckTargetView;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly operation: string;
  readonly executionConstraint?: import("@trust/procedure").CheckExecutionConstraint;
  readonly actionScope: ProcedureActionScopeView;
  readonly state: "OPEN" | "SATISFIED";
  readonly actionable: boolean;
  readonly escalatable: boolean;
  readonly attemptHandle: string | null;
  readonly completesPlan: boolean;
  readonly blockedBy: readonly string[];
  readonly latestVerdict: "VALIDATED" | "NOT_VALIDATED" | null;
  readonly latestReasonCode: string | null;
  readonly reason: string | null;
}

export interface ProcedureActionScopeView {
  readonly authorized: readonly string[];
  readonly forbidden: readonly string[];
}

export interface SessionView {
  readonly plan: string;
  readonly state: "OPEN" | "UNAVAILABLE";
  readonly activeRevision: number;
  readonly workState: "IN_PROGRESS" | "ESCALATED" | "COMPLETE";
  readonly checklistComplete: boolean;
  readonly satisfiedChecks: number;
  readonly openChecks: number;
  readonly sessions: readonly SessionRecordView[];
}

export interface CheckAttemptView {
  readonly handle: string;
  readonly attemptKey: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly state: AttemptState;
  readonly admittedAt: string;
  readonly expiresAt: string;
  readonly interruptedAt?: string;
  readonly finalizedAt?: string;
  readonly finalization?: AttemptQualification;
  readonly facts: readonly Fact[];
}

export interface CheckView {
  readonly checkUri: string;
  readonly name: string;
  readonly successReason: string;
  readonly scenario: string;
  readonly target: CheckTargetView;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly state: "OPEN" | "SATISFIED";
  readonly actionable: boolean;
  readonly escalatable: boolean;
  readonly attemptHandle: string | null;
  readonly blockedBy: readonly string[];
  readonly operation: string;
  readonly executionConstraint?: import("@trust/procedure").CheckExecutionConstraint;
  readonly actionScope: ProcedureActionScopeView;
  readonly context: Readonly<Record<string, unknown>>;
  readonly scenarioDependencies: readonly string[];
  readonly checkDependencies: readonly {
    readonly checkName: string;
    readonly providerCheckUri: string;
  }[];
  readonly latestVerdict: "VALIDATED" | "NOT_VALIDATED" | null;
  readonly latestReasonCode: string | null;
  readonly reason: string | null;
  readonly history: readonly {
    readonly snapshotId: string;
    readonly attemptHandle: string;
    readonly executionId: string;
    readonly state: "open" | "satisfied";
    readonly verdict: "VALIDATED" | "NOT_VALIDATED";
    readonly reasonCode: string;
    readonly reason: string;
    readonly checklistDelta: ChecklistDelta;
    readonly factIds: readonly string[];
    readonly calculatedAt: string;
  }[];
  readonly attempts: readonly CheckAttemptView[];
}

export interface CheckTargetView {
  readonly role: string;
  readonly selection: "one" | "each" | "all";
  readonly value: unknown;
}

export interface PlanEngagementInput {
  readonly contract: "trust.plan-engagement-request@1";
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly plan: string;
  readonly environment: string;
  readonly metadata?: RuntimeJsonObject | PlanMetadata;
  readonly rootInputs: RuntimeJsonObject;
  /** Defaults to "live". A dry-run Plan is driven by the operator: Facts come through the RPC boundary and no environment is resolved. */
  readonly mode?: PlanMode;
}

export interface PlanEngagementResult {
  readonly contract: "trust.plan-engagement@1";
  readonly status: "ENGAGED";
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly plan: string;
  readonly environment: string;
  readonly metadata: PlanMetadata;
  readonly mode: PlanMode;
  readonly revision: number;
  readonly checkUris: readonly string[];
}

/** Published and inline definitions use the same canonical compilation and child Plan execution. */
export type MissionDefinition =
  | { readonly kind: "published"; readonly reference: string }
  | { readonly kind: "inline"; readonly procedureSource: string; readonly operationSources: readonly string[] };

export interface MissionDeclaration {
  readonly id: string;
  readonly definition: MissionDefinition;
  readonly rootInputs: RuntimeJsonObject;
}

/** Accepted missions are append-only; identical resubmission preserves their pinned composition. */
export type MissionDeclarations = Readonly<Record<string, readonly MissionDeclaration[]>>;

/** Exact canonical composition captured when a mission is accepted, never re-resolved on replay. */
export interface ResolvedMission {
  readonly id: string;
  readonly procedure: import("@trust/procedure").CompiledProcedure;
}
export type ResolvedMissions = Readonly<Record<string, readonly ResolvedMission[]>>;

export interface PlanDeclarationReplacementInput {
  readonly contract: "trust.plan-declaration-replacement-request@1";
  readonly plan: string;
  readonly expectedRevision: number;
  readonly declarations: RuntimeJsonObject;
  readonly missionDeclarations?: MissionDeclarations;
}

export interface PlanDeclarationReplacementResult {
  readonly contract: "trust.plan-declaration-replacement@1";
  readonly status: "REPLACED";
  readonly plan: string;
  readonly revision: number;
  readonly declarations: RuntimeJsonObject;
  readonly checkUris: readonly string[];
  readonly removedCheckUris: readonly string[];
  readonly openedCheckUris: readonly string[];
}

export interface CheckEscalationInput {
  readonly contract: "trust.check-escalation-request@1";
  readonly checkUri: string;
  readonly attemptHandle: string;
  readonly blockingReason: string;
  readonly forbiddenFurtherAction: string;
}

export interface CheckEscalationResult {
  readonly contract: "trust.check-escalation@1";
  readonly status: "ESCALATED";
  readonly plan: string;
  readonly checkUri: string;
  readonly snapshotId: string;
  readonly blockingReason: string;
  readonly forbiddenFurtherAction: string;
  readonly escalatedAt: string;
}

export interface PlanResumptionResult {
  readonly contract: "trust.plan-resumption@1";
  readonly status: "RESUMED";
  readonly plan: string;
  readonly escalationId: string;
  readonly resumeReason: string;
  readonly resumedAt: string;
}

export interface PlanResumptionInput {
  readonly plan: string;
  readonly escalationId: string;
  readonly resumeReason: string;
}

export interface CheckAttemptAdmissionInput {
  readonly contract: "trust.check-admission-request@1";
  readonly attemptKey: string;
  readonly checkUri: string;
  readonly reobserve?: boolean;
  readonly intent?: string;
  readonly nextIntent?: string;
}

export type CheckAttemptAdmissionResult =
  | {
      readonly contract: "trust.check-admission@1";
      readonly status: "ADMITTED";
      readonly attemptKey: string;
      readonly attemptHandle: string;
      readonly executionId: string;
      readonly checkUri: string;
      readonly operation: import("@trust/operation").CompiledOperation;
      readonly actionInput: RuntimeJsonObject;
      readonly environment: RuntimeJsonObject;
      /** Procedure-declared Check constraint. Absent for dry-runs and unconstrained live Checks. */
      readonly executionConstraint?: import("@trust/procedure").CheckExecutionConstraint;
      readonly expiresAt: string;
    }
  | Refusal;

export interface Refusal {
  readonly contract: "trust.check-admission@1";
  readonly status: "REFUSED";
  readonly attemptKey: string;
  readonly reasonCode: string;
  readonly reason: string;
  readonly next: { readonly action: "READ_PLAN" };
}

export interface FactBatchInput {
  readonly attemptKey: string;
  readonly attemptHandle: string;
  readonly executionId: string;
  readonly checkUri: string;
  readonly facts: readonly RuntimeJsonObject[];
  readonly recordedAt: string;
}

export interface FactBatchResult {
  readonly acceptedFactIds: readonly string[];
  readonly duplicateFactIds: readonly string[];
}

export interface AttemptFinalizationResult {
  readonly contract: "trust.attempt-finalization@1";
  readonly attemptHandle: string;
  readonly plan: string;
  readonly checkUri: string;
  readonly verdict: "VALIDATED" | "NOT_VALIDATED";
  readonly reasonCode: string;
  readonly reason: string;
  readonly checklistDelta: ChecklistDelta;
}

export interface AttemptInterruptionResult {
  readonly contract: "trust.attempt-interruption@1";
  readonly status: "INTERRUPTED";
  readonly attemptHandle: string;
}

export interface InvocationView {
  id: string;
  name: string;
  mission?: { readonly collection: string; readonly id: string };
  scenario: string;
  state: "WAITING" | "RUNNING" | "SATISFIED";
  blockedBy: string[];
  childPlan: string | null;
  generation: number | null;
  history: { generation: number; childPlan: string; supersededAt: string | null }[];
}
export interface DescendantEscalation {
  plan: string;
  mode: "live" | "dry-run";
  title: string;
  escalationId: string;
  checkUri: string;
  blockingReason: string;
  forbiddenFurtherAction: string;
  escalatedAt: string;
  path: { parentPlan: string; invocationId: string; generation: number; childPlan: string }[];
}

export type AttemptState = "pending" | "interrupted" | "finalized";

export interface Fact {
  id: string;
  attemptHandle: string;
  executionId: string;
  checkUri: string;
  compiledCheckDigest: string;
  index: number;
  operation: string;
  operationDigest: string;
  observedAt: string;
  recordedAt: string;
  values: RuntimeJsonObject;
}

export type CheckState = "open" | "satisfied";
export type ChecklistVerdict = "VALIDATED" | "NOT_VALIDATED";

export interface ChecklistDelta {
  newlySatisfied: readonly string[];
  newlyOpened: readonly string[];
  unchanged: readonly string[];
}

export type TrialStatus = "starting" | "running" | "succeeded" | "failed" | "aborted";

export interface TrialEvent {
  readonly sequence: number;
  readonly type: string;
  readonly at: string;
  readonly [key: string]: unknown;
}

export interface TrialRecord {
  readonly id: string;
  readonly operation: string;
  readonly version: string;
  readonly environment: string;
  readonly input: RuntimeJsonObject;
  readonly startedAt: string;
  readonly startedBy: string;
  status: TrialStatus;
  endedAt?: string;
  outcome?: RuntimeJsonObject;
  error?: string;
  events: TrialEvent[];
}

export interface TrialSummary {
  readonly id: string;
  readonly operation: string;
  readonly version: string;
  readonly environment: string;
  readonly startedAt: string;
  readonly startedBy: string;
  readonly status: TrialStatus;
  readonly endedAt?: string;
  readonly error?: string;
  readonly eventCount: number;
}

export type EnvironmentValues = Readonly<Record<string, string>>;

export interface EnvironmentView {
  readonly name: string;
  readonly values: EnvironmentValues;
}

/** Environment list optionally qualified for one Operation. */
export interface EnvironmentEntry extends EnvironmentView {
  readonly compatible?: boolean;
  readonly missing?: readonly string[];
}
export interface QualifiedEnvironmentView extends EnvironmentView {
  readonly compatible: boolean;
  readonly missing: readonly string[];
}
export interface OperationEnvironments {
  readonly operation: string;
  readonly version: string;
  readonly environments: readonly Omit<QualifiedEnvironmentView, "values">[];
}

export interface CredentialReference {
  readonly environment: string;
  readonly name: string;
}

export interface PublishedProcedure {
  readonly procedure: CompiledProcedure;
  readonly sourceName: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export {
  isTemplateParameterName,
  materializeTemplate,
  scanTemplatePlaceholders,
  TemplateDefinitionError,
  templateConstraints,
  templateDocumentContextMethod,
  validateTemplateDefinition,
  validateTemplateParameters,
} from "./templates.js";
