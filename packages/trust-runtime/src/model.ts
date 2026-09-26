import type {
  AttemptQualification,
  AttemptState,
  ChecklistDelta,
  ChecklistVerdict,
  CheckState,
  ExternalPrincipal,
  IntentChainState,
  MissionDeclarations,
  PlanImportedResult,
  PlanMetadata,
  PlanMode,
  ResolvedMissions,
  RuntimeJsonObject,
} from "@trust/extension-sdk";
import type { CompiledOperation } from "@trust/operation";
import type { CompiledProcedure, CompiledProcedureCheck, CompiledProcedureInvocation } from "@trust/procedure";

export interface Plan {
  readonly creator: ExternalPrincipal | null;
  slug: string;
  procedure: string;
  procedureVersion: string;
  environment: string;
  mode: PlanMode;
  intentChaining: boolean;
  intentChainState: IntentChainState;
  currentIntent?: string;
  currentIntentCheckUri?: string;
  currentIntentAttemptKey?: string;
  metadata: PlanMetadata;
  rootInputs: RuntimeJsonObject;
  currentRevision: number;
  createdAt: string;
}

/** A declared, planned exit from a Procedure. It stops Check admission without qualifying anything. */
export interface PlanEscalation {
  id: string;
  planSlug: string;
  planRevision: number;
  snapshotPlanRevision: number;
  checkUri: string;
  compiledCheckDigest: string;
  snapshotId: string;
  attemptHandle: string;
  blockingReason: string;
  forbiddenFurtherAction: string;
  escalatedAt: string;
  resumedAt?: string;
  resumeReason?: string;
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
  resolvedProcedure: CompiledProcedure;
  procedure: string;
  procedureVersion: string;
  environment: string;
  mode: PlanMode;
  intentChaining: boolean;
  metadata: PlanMetadata;
  rootInputs: RuntimeJsonObject;
  agentDeclarations: RuntimeJsonObject;
  missionDeclarations: MissionDeclarations;
  resolvedMissions: ResolvedMissions;
  planSlug: string;
  revision: number;
  definitionDigest: string;
  source: string;
  checks: readonly PlanCheck[];
  invocations: readonly PlanInvocation[];
  roleValues: readonly ProducedRoleValue[];
  importedValues: readonly PlanImportedResult[];
  checkValues: readonly CheckValues[];
}

export interface PlanInvocation {
  id: string;
  mission?: { readonly collection: string; readonly id: string };
  definition: CompiledProcedureInvocation;
  rootInputs: RuntimeJsonObject;
  scenarioDependencies: readonly string[];
}

export interface ChildGeneration {
  parentPlan: string;
  invocationId: string;
  generation: number;
  childPlan: string;
  inputDigest: string;
  createdAt: string;
  supersededAt: string | null;
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

export interface Attempt {
  readonly actor: ExternalPrincipal | null;
  invocationDigest?: string;
  handle: string;
  attemptKey: string;
  executionId: string;
  planSlug: string;
  planRevision: number;
  checkUri: string;
  compiledCheckDigest: string;
  sessionId: string;
  operation: string;
  operationDigest: string;
  actionInput: RuntimeJsonObject;
  environment: string;
  reobserve: boolean;
  intent?: string;
  nextIntent?: string;
  state: AttemptState;
  admittedAt: string;
  expiresAt: string;
  interruptedAt?: string;
  finalizedAt?: string;
  finalization?: AttemptQualification;
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
