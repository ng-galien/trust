export type JsonObject = Record<string, unknown>;

export interface OperationStep {
  name: string;
  type: "shell" | "http" | "file-read";
  [key: string]: unknown;
}

export interface CompiledOperation {
  contract: "trust.compiled-operation@1";
  operation: string;
  version: string;
  title: string;
  description?: string;
  source: string;
  input: JsonObject;
  environment: JsonObject;
  steps: OperationStep[];
  produce: { language: "jsonata"; expression: string };
  produced: JsonObject;
  classification?: Record<string, string[]>;
}

export interface ProcedureCheck {
  name: string;
  scenario: string;
  operation: string;
  operationVersion?: string;
  target?: { role: string; selection: string };
  inputBindings?: Array<{ input: string; role: string; selection: string }>;
  materializes?: Array<{ role: string; field: string }>;
  qualification: {
    source: string;
    guards: Array<{
      conditionLogic: JsonLogicRule;
      failureReasonLogic: JsonLogicRule;
      references: Array<
        ({ kind: "fact"; field: string } | { kind: "context"; role: string } | { kind: "check"; check: string; field: string })
        & { valueType: string; cardinality: "one" | "many" }
      >;
    }>;
    location: { line: number; column: number };
  };
  successReason: string;
}

export type JsonLogicRule = null | boolean | number | string | JsonLogicRule[] | { [operator: string]: JsonLogicRule };

export interface ProcedureScenario {
  slug: string;
  title: string;
  dependencies: string[];
  checks: string[];
}

export interface CompiledProcedure {
  procedure: string;
  version: string;
  title: string;
  description?: string;
  source: string;
  definitionDigest: string;
  operations: Array<{ operation: string; version: string; digest: string; definition: CompiledOperation }>;
  roles: Array<{ name: string; type: string; cardinality: string; source: JsonObject }>;
  scenarios: ProcedureScenario[];
  checks: ProcedureCheck[];
}

export interface PublishedProcedure {
  procedure: CompiledProcedure;
  sourceName: string;
  publishedBy: string;
  publishedAt: string;
}

export type PlanMode = "live" | "dry-run";

export interface PlanSummary {
  plan: string;
  procedure: string;
  procedureVersion: string;
  environment: string;
  /** dry-run: the operator plays the agent (Facts posted over RPC, no environment ever resolved). */
  mode: PlanMode;
  revision: number;
  createdAt: string;
  sessionState: "OPEN" | "UNAVAILABLE";
  workState: "IN_PROGRESS" | "COMPLETE";
  satisfiedChecks: number;
  checkCount: number;
}

export interface PlanCheck {
  checkUri: string;
  name: string;
  scenario: string;
  target: { role: string; selection: string; value: unknown };
  inputs: JsonObject;
  operation: string;
  state: "OPEN" | "SATISFIED";
  actionable: boolean;
  blockedBy: string[];
  latestVerdict: "VALIDATED" | "NOT_VALIDATED" | null;
  latestReasonCode: string | null;
  reason: string | null;
}

export interface DeclarationRole {
  role: string;
  type: string;
  cardinality: string;
  parents: Array<{ role: string; each: boolean }>;
}

export interface PlanView extends PlanSummary {
  rootInputs: JsonObject;
  declarations: JsonObject;
  declarationRoles: DeclarationRole[];
  missingDeclarations: string[];
  latestQualification: { checkUri: string; verdict: "VALIDATED" | "NOT_VALIDATED"; reasonCode: string; reason: string; newlySatisfied: string[]; newlyOpened: string[]; unchanged: string[] } | null;
  latestRevisionChange: { fromRevision: number | null; toRevision: number; added: string[]; removed: string[]; newlySatisfied: string[]; newlyOpened: string[]; changed: string[]; unchanged: string[] };
  checklistComplete: boolean;
  openChecks: string[];
  actionableChecks: string[];
  blockedChecks: string[];
  checks: PlanCheck[];
  revisions: Array<{ revision: number; definitionDigest: string; source: string; checkUris: string[] }>;
  sessions: Array<{ id: string; state: string; openedAt: string; expiresAt: string; closedAt?: string }>;
}

export interface Fact {
  id: string;
  values?: JsonObject;
  observedAt?: string;
  [key: string]: unknown;
}

/** One immutable verdict snapshot across Plans and dry-runs (`history.list`, newest first, cursor-paginated). */
export interface HistorySnapshot {
  snapshotId: string;
  calculatedAt: string;
  plan: string;
  mode: PlanMode;
  procedure: string;
  checkUri: string;
  checkName: string;
  target: { role: string; selection: string; value: unknown };
  operation: string;
  attemptHandle: string;
  verdict: "VALIDATED" | "NOT_VALIDATED";
  reasonCode: string;
  reason: string;
  factCount: number;
  checklistDelta: { newlySatisfied: string[]; newlyOpened: string[]; unchanged: string[] };
}

export interface HistoryFilter {
  plan?: string;
  procedure?: string;
  mode?: PlanMode;
  verdict?: "VALIDATED" | "NOT_VALIDATED";
  since?: string;
  until?: string;
}

export interface CheckView extends PlanCheck {
  context: JsonObject;
  scenarioDependencies: string[];
  checkDependencies: Array<{ checkName: string; providerCheckUri: string }>;
  history: Array<{
    snapshotId: string;
    attemptHandle: string;
    state: string;
    verdict: "VALIDATED" | "NOT_VALIDATED";
    reasonCode: string;
    reason: string;
    factIds: string[];
    calculatedAt: string;
  }>;
  attempts: Array<{
    handle: string;
    attemptKey: string;
    sessionId: string;
    state: string;
    admittedAt: string;
    expiresAt: string;
    finalizedAt?: string;
    facts: Fact[];
  }>;
}

export interface PlanEngagement {
  contract: "trust.plan-engagement@1";
  status: "ENGAGED";
  procedure: string;
  procedureVersion: string;
  plan: string;
  environment: string;
  mode: PlanMode;
  revision: number;
  checkUris: string[];
}

export interface DeclarationReplacement {
  plan: string;
  revision: number;
  declarations: JsonObject;
  checkUris: string[];
  removedCheckUris: string[];
  openedCheckUris: string[];
}

export type CheckAdmission =
  | { status: "ADMITTED"; attemptKey: string; attemptHandle: string; checkUri: string; operation: CompiledOperation; actionInput: JsonObject; environment: JsonObject; expiresAt: string }
  | { status: "REFUSED"; attemptKey: string; reasonCode: string; reason: string };

export interface AttemptFinalization {
  attemptHandle: string;
  verdict: "VALIDATED" | "NOT_VALIDATED";
  reasonCode: string;
  reason: string;
  checklistDelta: { newlySatisfied: string[]; newlyOpened: string[]; unchanged: string[] };
}

export interface OperationSimulation {
  contract: "trust.operation-simulation@1";
  operation: CompiledOperation;
  input: JsonObject;
  environment: JsonObject;
  steps: JsonObject;
  produced: JsonObject;
}

export type TrialStatus = "starting" | "running" | "succeeded" | "failed" | "aborted";

export interface TrialSummary {
  id: string;
  operation: string;
  version: string;
  environment: string;
  startedAt: string;
  startedBy: string;
  status: TrialStatus;
  endedAt?: string;
  error?: string;
  eventCount: number;
}

export interface TrialEvent {
  sequence: number;
  type: string;
  at: string;
  [key: string]: unknown;
}

export interface TrialView extends TrialSummary {
  input: JsonObject;
  outcome?: JsonObject;
  events: TrialEvent[];
}

export interface EnvironmentEntry {
  name: string;
  values: JsonObject;
  /** Present when the list was qualified against one operation. */
  compatible?: boolean;
  missing?: string[];
}

/** A credential the runtime holds for an environment — by reference only, the value is never exposed. */
export interface CredentialReference {
  environment: string;
  name: string;
}

export interface OperationEnvironments {
  operation: string;
  version: string;
  environments: Array<{ name: string; compatible: boolean; missing: string[] }>;
}
