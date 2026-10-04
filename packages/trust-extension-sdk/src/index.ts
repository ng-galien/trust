export type { BrowserAuthenticationConfiguration } from "./browser-authentication.js";

/** Public extension and client contracts. No runtime implementation dependency. */

export type {
  AccessAction,
  AccessContext,
  ExtensionCommandAccess,
  ExtensionCommandAction,
  ExtensionUseAction,
  ExternalPrincipal,
  PlanAccessAction,
  PlanAccessScope,
  ResourceAccessAction,
} from "./access.js";
export { extensionScope, extensionUseScope, PLAN_ACCESS_ACTIONS, RESOURCE_ACCESS_ACTIONS } from "./access.js";

export type { CatalogMetadata, CatalogMetadataUpdate } from "./catalog.js";
export type {
  ExtensionContext,
  ExtensionDescriptor,
  ExtensionEventStream,
  ExtensionFactory,
  ExtensionInvocationContext,
  ExtensionLifecycle,
  ExtensionPageProps,
  ExtensionState,
  ExtensionTrust,
  ExtensionTrustFailure,
  ExtensionUiTransport,
} from "./extension.js";
export { EXTENSION_TRUST_FAILURES, ExtensionTrustError } from "./extension.js";
export type {
  RegistryAvailablePackage,
  RegistryCatalogImportEntry,
  RegistryContentCategory,
  RegistryContentDeclaration,
  RegistryContentKind,
  RegistryErrorReason,
  RegistryExtensionDeclaration,
  RegistryExtensionInstallationValues,
  RegistryFailure,
  RegistryInstallationSteps,
  RegistryInstalledPackage,
  RegistryPackageCatalog,
  RegistryPackageContent,
  RegistryPackageDeclaration,
  RegistryPackageIndex,
  RegistryPackageInstallation,
  RegistryPackageInstallRequest,
  RegistryPackageItem,
  RegistryPackageUninstallation,
  RegistryPackageUninstallRequest,
  RegistryPackageUpdate,
  RegistryPackageUpdateRequest,
  RegistrySource,
  RegistrySourceIndexView,
  RegistrySourceInput,
  RegistrySourceKind,
  RegistrySourceRemoval,
  RegistryStep,
  RegistryStepStatus,
} from "./registry.js";
export {
  REGISTRY_ARTIFACT_INDEX_CONTRACT,
  REGISTRY_INDEX_FILE,
  REGISTRY_PACKAGE_INDEX_CONTRACT,
} from "./registry.js";
export type {
  ExtensionBooleanSetting,
  ExtensionIntegerSetting,
  ExtensionNumberSetting,
  ExtensionSettingProperty,
  ExtensionSettingsIssue,
  ExtensionSettingsRequirement,
  ExtensionSettingsSchema,
  ExtensionSettingsUpdate,
  ExtensionSettingsUpdateResult,
  ExtensionSettingsValidation,
  ExtensionSettingsValues,
  ExtensionSettingsView,
  ExtensionSettingValue,
  ExtensionStorageFailure,
  ExtensionStringSetting,
  ExtensionStringSettingFormat,
} from "./settings.js";
export {
  EXTENSION_STORAGE_FAILURES,
  ExtensionSettingsSchemaError,
  extensionCredentialSettings,
  formatExtensionSettingsIssues,
  isExtensionStorageFailure,
  parseExtensionSettingsSchema,
  validateExtensionSettings,
} from "./settings.js";

import type {
  ExtensionSettingsSchema,
  ExtensionSettingsUpdate,
  ExtensionSettingsUpdateResult,
  ExtensionSettingsValues,
  ExtensionSettingsView,
} from "./settings.js";

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
  /** Absolute path of the installed `extension.json`. */
  manifest: string;
  requestedCapabilities: ExtensionCapability[];
  settingsSchema: ExtensionSettingsSchema;
  /** Stored values; a credential setting holds the environment variable name. */
  settings: ExtensionSettingsValues;
  environment: string;
  grants: ExtensionCapability[];
  credentialEnvironment: string[];
  autoStart: boolean;
  ui?: { name: string; entry: string; module: string; assets: string };
  mcp?: { description: string; commands: CommandDeclaration[] };
}

export const EXTENSION_CAPABILITIES = ["plans.read", "plans.subscribe", "plans.declare", "catalog.read"] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

/** Registry installer request: one installed `extension.json` and this installation's own values. */
export interface ExtensionInstallationRequest {
  /** Absolute path of the installed `extension.json`; its `id` becomes the installation identity. */
  readonly manifest: string;
  readonly environment: string;
  readonly grants: readonly ExtensionCapability[];
  readonly credentialEnvironment?: readonly string[];
  readonly autoStart?: boolean;
  readonly settings: ExtensionSettingsValues;
}
/** Replace an installation by another installed version of the same extension identity. */
export interface ExtensionReplacementRequest {
  readonly manifest: string;
  /** Defaults to the current values, which must satisfy the new version's schema. */
  readonly settings?: ExtensionSettingsValues;
  /** Defaults to the current grants, which must remain requested by the new version. */
  readonly grants?: readonly ExtensionCapability[];
}
export interface ExtensionReplacementResult {
  readonly extension: import("./extension.js").ExtensionDescriptor;
  readonly previousVersion: string;
  readonly preparationRequired: boolean;
}

export interface ExtensionRemovalOptions {
  /** Run the extension's `deleteData` hook while stopped; refused when the extension declares none. */
  readonly deleteData?: boolean;
}
export interface ExtensionRemovalResult {
  readonly extension: string;
  readonly dataDeleted: boolean;
}

/**
 * Host contract used by the registry installer. Every operation is serialized per installation, stops the
 * running instance before changing it, never prepares or migrates a store and never touches other installations.
 * Installations declared by the operator installation file can be reconfigured and replaced, not removed.
 */
export interface ExtensionInstallationHost {
  install(request: ExtensionInstallationRequest): Promise<import("./extension.js").ExtensionDescriptor>;
  replace(id: string, request: ExtensionReplacementRequest): Promise<ExtensionReplacementResult>;
  /** Without `deleteData`, the extension's own stored data is kept. */
  remove(id: string, options?: ExtensionRemovalOptions): Promise<ExtensionRemovalResult>;
  readSettings(id: string): Promise<ExtensionSettingsView>;
  updateSettings(update: ExtensionSettingsUpdate): Promise<ExtensionSettingsUpdateResult>;
}

export interface CommandDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

import type { CompiledProcedure, CompiledVocabulary } from "@trust/procedure";

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
  readonly creator: import("./access.js").ExternalPrincipal | null;
  readonly descendantEscalations: readonly DescendantEscalation[];
  readonly invocations: readonly InvocationView[];
  readonly parent: PlanParentView | null;
  readonly plan: string;
  readonly procedure: string;
  readonly procedureVersion: string;
  readonly procedureTitle: string;
  /** Controlled language of the Plan's Procedure; present only when the Procedure carries the tag. */
  readonly controlledLanguage?: import("@trust/procedure").CompiledControlledLanguage;
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
    The source views retain their own revision, Fact, and qualification provenance. The Plan views carry empty
    `revisions` and `sessions`: read the Plan itself for its revision history and sessions. */
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
  readonly creator: import("./access.js").ExternalPrincipal | null;
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
  readonly actor: import("./access.js").ExternalPrincipal | null;
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

/** Operator resolution of an escalated child Plan: abandon its generation and start the next one. */
export interface PlanRelaunchInput {
  readonly plan: string;
  readonly escalationId: string;
  readonly relaunchReason: string;
}

export interface PlanRelaunchResult {
  readonly contract: "trust.plan-relaunch@1";
  readonly status: "RELAUNCHED";
  /** The abandoned child Plan; it keeps its history and admits no further Check. */
  readonly plan: string;
  readonly escalationId: string;
  readonly relaunchReason: string;
  readonly relaunchedAt: string;
  readonly parentPlan: string;
  readonly invocationId: string;
  readonly supersededGeneration: number;
  /** The next generation of the same invocation, created with the same pinned definition and inputs. */
  readonly generation: number;
  readonly childPlan: string;
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
      /** Values of exactly the Credentials the admitted Operation declares, resolved from the Plan
          Environment. Never merged into `environment`, never persisted; empty for a dry-run. */
      readonly credentials: Readonly<Record<string, string>>;
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
  /** Controlled language findings on the declared `nextIntent`; present only for the `controlled-language` reason. */
  readonly findings?: readonly import("@trust/procedure").ControlledLanguageFinding[];
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

/** One immutable catalog version of a controlled language vocabulary. */
export interface PublishedVocabulary {
  readonly vocabulary: CompiledVocabulary;
  readonly sourceName: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export type { AccessConfiguration, SharedAccessConfiguration } from "./access-configuration.js";
export { authorityUrl, parseAccessConfiguration } from "./access-configuration.js";
export type {
  AuthenticationConfiguration,
  DevelopmentAuthenticationConfiguration,
} from "./authentication-configuration.js";
export { parseAuthenticationConfiguration } from "./authentication-configuration.js";
export { assertNoSecretLikeValue, normalizeAuthority } from "./authority.js";
export type {
  ConfigurationEnvironment,
  ConfigurationSource,
  ResolvedTrustConfiguration,
  StorageConfiguration,
  TrustConfiguration,
} from "./configuration.js";
export {
  configurationAuthority,
  loadTrustConfiguration,
  publicTrustConfiguration,
  resolveTrustConfiguration,
  TRUST_CONFIGURATION_SCHEMA,
} from "./configuration.js";
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
