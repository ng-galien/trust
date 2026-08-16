import type { CompiledOperation } from "@trust/operation";
import type { CompiledProcedureCheck } from "@trust/procedure";

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

export interface PlanCheck {
  uri: string;
  planSlug: string;
  planRevision: number;
  scenario: string;
  expansion: readonly string[];
  check: CompiledProcedureCheck;
  operation: CompiledOperation;
  compiledCheckDigest: string;
  currentContextDigest?: string;
  actionInput: RuntimeJsonObject;
  context: RuntimeJsonObject;
  scope: {
    readonly role: string;
    readonly value: unknown;
    readonly parents: RuntimeJsonObject;
  };
  scenarioDependencies: readonly string[];
  checkDependencies: readonly { readonly checkName: string; readonly providerCheckUri: string }[];
}

export interface ProducedRoleValue {
  role: string;
  value: unknown;
  parents: RuntimeJsonObject;
  providerCheckUri: string;
}

export interface CheckValues {
  checkName: string;
  providerCheckUri: string;
  parents: RuntimeJsonObject;
  values: RuntimeJsonObject;
}

export interface PlanRevision {
  procedure: string;
  procedureVersion: string;
  environment: string;
  rootInputs: RuntimeJsonObject;
  agentDeclarations: RuntimeJsonObject;
  planSlug: string;
  revision: number;
  definitionDigest: string;
  source: string;
  checks: readonly PlanCheck[];
  roleValues: readonly ProducedRoleValue[];
  checkValues: readonly CheckValues[];
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

export type AttemptState = "pending" | "finalized";

export interface Attempt {
  handle: string;
  attemptKey: string;
  planSlug: string;
  planRevision: number;
  checkUri: string;
  compiledCheckDigest: string;
  sessionId: string;
  operation: string;
  operationDigest: string;
  actionInput: RuntimeJsonObject;
  environment: string;
  state: AttemptState;
  admittedAt: string;
  expiresAt: string;
  finalizedAt?: string;
  finalization?: {
    readonly verdict: "VALIDATED" | "NOT_VALIDATED";
    readonly reasonCode: string;
    readonly reason: string;
    readonly checklistDelta: {
      readonly newlySatisfied: readonly string[];
      readonly newlyOpened: readonly string[];
      readonly unchanged: readonly string[];
    };
  };
}

export interface Fact {
  id: string;
  attemptHandle: string;
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

export interface CheckSnapshot {
  id: string;
  attemptHandle: string;
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

export interface ActiveCheckQualification {
  planSlug: string;
  planRevision: number;
  checkUri: string;
  compiledCheckDigest: string;
  snapshotId: string;
  activationDigest: string;
}
