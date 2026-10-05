import type {
  AccessContext,
  CheckAttemptAdmissionInput as CheckAttemptAdmissionParams,
  CheckEscalationInput,
  FactBatchInput,
  HistoryListInput,
  PlanCancellationInput,
  PlanDeclarationReplacementInput,
  PlanEngagementInput as PlanEngagementParams,
  PlanListInput,
  PlanRelaunchInput,
  PlanResumptionInput,
  RuntimeJsonObject,
} from "@trust/extension-sdk";
import { PLAN_WORK_STATES } from "@trust/extension-sdk";
import { AccessError } from "../access/error.js";
import { checkContinuation } from "../plan/continuation.js";
import { parseMissionDeclarations } from "../plan/mission-declarations.js";
import type { PlanReader, ReadErrorCode } from "../plan/read.js";
import type { PlanRuntime } from "../plan/runtime.js";

export const PLAN_ENGAGE_METHOD = "plan.engage" as const;
export const PLAN_LIST_METHOD = "plan.list" as const;
export const HISTORY_LIST_METHOD = "history.list" as const;
export const PLAN_READ_METHOD = "plan.read" as const;
export const SESSION_READ_METHOD = "session.read" as const;
export const CHECK_READ_METHOD = "check.read" as const;
export const PLAN_DECLARATIONS_REPLACE_METHOD = "plan.declarations.replace" as const;
export const PLAN_REMOVE_METHOD = "plan.remove" as const;
export const PLAN_RESET_METHOD = "plan.reset" as const;
export const PLAN_CLOSE_METHOD = "plan.close" as const;
export const PLAN_RESUME_METHOD = "plan.resume" as const;
export const PLAN_RELAUNCH_METHOD = "plan.relaunch" as const;
export const PLAN_CANCEL_METHOD = "plan.cancel" as const;
export const CHECK_ATTEMPT_ADMIT_METHOD = "check.attempt.admit" as const;
export const CHECK_ATTEMPT_FACTS_METHOD = "check.attempt.facts" as const;
export const CHECK_ATTEMPT_FINALIZE_METHOD = "check.attempt.finalize" as const;
export const CHECK_ATTEMPT_INTERRUPT_METHOD = "check.attempt.interrupt" as const;
export const CHECK_ESCALATE_METHOD = "check.escalate" as const;
export const PLAN_RUNTIME_ERROR_CONTRACT = "trust.plan-runtime-error@1" as const;

interface CheckReadParams {
  readonly contract: "trust.check-read-request@1";
  readonly checkUri: string;
}

interface CheckAttemptFinalizationParams {
  readonly contract: "trust.attempt-finalization-request@1";
  readonly attemptHandle: string;
}

interface CheckAttemptInterruptionParams {
  readonly contract: "trust.attempt-interruption-request@1";
  readonly attemptHandle: string;
}

export interface PlanRuntimeFailureData {
  readonly contract: typeof PLAN_RUNTIME_ERROR_CONTRACT;
  readonly reason: import("../plan/runtime.js").PlanRuntimeErrorCode | ReadErrorCode;
  readonly message: string;
  /** Controlled language findings; present only for the `controlled-language` reason. */
  readonly findings?: readonly import("@trust/procedure").ControlledLanguageFinding[];
}

export const PLAN_RUNTIME_RPC_METHODS = [
  PLAN_ENGAGE_METHOD,
  PLAN_LIST_METHOD,
  HISTORY_LIST_METHOD,
  PLAN_READ_METHOD,
  PLAN_DECLARATIONS_REPLACE_METHOD,
  PLAN_REMOVE_METHOD,
  PLAN_RESET_METHOD,
  PLAN_CLOSE_METHOD,
  PLAN_RESUME_METHOD,
  PLAN_RELAUNCH_METHOD,
  PLAN_CANCEL_METHOD,
  SESSION_READ_METHOD,
  CHECK_READ_METHOD,
  CHECK_ATTEMPT_ADMIT_METHOD,
  CHECK_ATTEMPT_FACTS_METHOD,
  CHECK_ATTEMPT_FINALIZE_METHOD,
  CHECK_ATTEMPT_INTERRUPT_METHOD,
  CHECK_ESCALATE_METHOD,
] as const;

export type PlanRuntimeRpcMethod = (typeof PLAN_RUNTIME_RPC_METHODS)[number];

export interface PlanRuntimeRpcDependencies {
  readonly access?: AccessContext | undefined;
  readonly planReader: PlanReader;
  readonly planRuntime: PlanRuntime;
}

export class InvalidPlanRuntimeRpcParams extends Error {
  constructor() {
    super("invalid Plan runtime RPC params");
    this.name = "InvalidPlanRuntimeRpcParams";
  }
}

export function isPlanRuntimeRpcMethod(method: string): method is PlanRuntimeRpcMethod {
  return (PLAN_RUNTIME_RPC_METHODS as readonly string[]).includes(method);
}

export async function executePlanRuntimeRpc(
  method: PlanRuntimeRpcMethod,
  params: unknown,
  dependencies: PlanRuntimeRpcDependencies,
): Promise<unknown> {
  switch (method) {
    case PLAN_LIST_METHOD:
      return {
        contract: "trust.plan-catalog@1",
        ...(await dependencies.planReader.listPlans(parsePlanList(params), dependencies.access)),
      };
    case HISTORY_LIST_METHOD:
      return {
        contract: "trust.check-history@1",
        ...(await dependencies.planReader.listHistory(parseHistoryList(params), dependencies.access)),
      };
    case PLAN_READ_METHOD: {
      const input = parsePlanRead(params);
      return {
        contract: "trust.plan-view@1",
        ...(await dependencies.planReader.readPlanBySlug(input.plan, true, dependencies.access)),
      };
    }
    case SESSION_READ_METHOD: {
      const input = parsePlanRead(params);
      return {
        contract: "trust.session-view@1",
        ...(await dependencies.planReader.readSessionBySlug(input.plan, dependencies.access)),
      };
    }
    case PLAN_ENGAGE_METHOD: {
      const input = parsePlanEngagement(params);
      return dependencies.planRuntime.engage(input, dependencies.access);
    }
    case PLAN_REMOVE_METHOD: {
      const input = parsePlanRead(params);
      return dependencies.planRuntime.remove(input.plan, dependencies.access);
    }
    case PLAN_RESET_METHOD: {
      const input = parsePlanRead(params);
      return dependencies.planRuntime.reset(input.plan, dependencies.access);
    }
    case PLAN_CLOSE_METHOD: {
      const input = parsePlanRead(params);
      return dependencies.planRuntime.close(input.plan, dependencies.access);
    }
    case PLAN_RESUME_METHOD: {
      const input = parsePlanResumption(params);
      return dependencies.planRuntime.resumePlan(input, dependencies.access);
    }
    case PLAN_RELAUNCH_METHOD: {
      const input = parsePlanRelaunch(params);
      return dependencies.planRuntime.relaunchPlan(input, dependencies.access);
    }
    case PLAN_CANCEL_METHOD: {
      const input = parsePlanCancellation(params);
      return dependencies.planRuntime.cancelPlan(input, dependencies.access);
    }
    case PLAN_DECLARATIONS_REPLACE_METHOD: {
      const input = parsePlanDeclarationReplacement(params);
      return dependencies.planRuntime.replaceDeclarations(input, dependencies.access);
    }
    case CHECK_ATTEMPT_FACTS_METHOD: {
      const input = parseFactBatch(params);
      return dependencies.planRuntime.ingestDryRunFacts(input, dependencies.access);
    }
    case CHECK_READ_METHOD: {
      const input = parseCheckRead(params);
      const view = await dependencies.planReader.readCheck(input.checkUri, dependencies.access);
      return { contract: "trust.check-view@1", ...view };
    }
    case CHECK_ATTEMPT_ADMIT_METHOD: {
      const input = parseCheckAdmission(params);
      return dependencies.planRuntime.admitCheck(input, dependencies.access);
    }
    case CHECK_ATTEMPT_FINALIZE_METHOD: {
      const input = parseCheckFinalization(params);
      const finalized = await dependencies.planRuntime.finalizeCheck(input.attemptHandle, dependencies.access);
      const view = await dependencies.planReader
        .readPlanBySlug(finalized.plan, false, dependencies.access)
        .catch((error: unknown) => {
          if (error instanceof AccessError) return undefined;
          throw error;
        });
      return {
        contract: finalized.contract,
        attemptHandle: finalized.attemptHandle,
        verdict: finalized.verdict,
        reasonCode: finalized.reasonCode,
        reason: finalized.reason,
        checklistDelta: finalized.checklistDelta,
        next:
          view === undefined
            ? { action: "READ_PLAN" }
            : checkContinuation(view, {
                checkUri: finalized.checkUri,
                verdict: finalized.verdict,
              }),
      };
    }
    case CHECK_ATTEMPT_INTERRUPT_METHOD: {
      const input = parseCheckInterruption(params);
      return dependencies.planRuntime.interruptCheck(input.attemptHandle, dependencies.access);
    }
    case CHECK_ESCALATE_METHOD: {
      const input = parseCheckEscalation(params);
      return dependencies.planRuntime.escalateCheck(input, dependencies.access);
    }
  }
}

/** The reason is validated by the runtime, so a missing or blank reason is refused with an explicit message. */
export function parsePlanCancellation(value: unknown): PlanCancellationInput {
  const record = exactRecord(value, ["plan"], ["reason"]);
  if (!boundedString(record.plan) || (record.reason !== undefined && typeof record.reason !== "string")) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return { plan: record.plan, reason: record.reason ?? "" };
}

function parsePlanRelaunch(value: unknown): PlanRelaunchInput {
  const record = exactRecord(value, ["plan", "escalationId", "relaunchReason"]);
  if (
    !boundedString(record.plan) ||
    !boundedString(record.escalationId) ||
    !boundedTrimmedString(record.relaunchReason, 4_096)
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return { plan: record.plan, escalationId: record.escalationId, relaunchReason: record.relaunchReason };
}

function parsePlanResumption(value: unknown): PlanResumptionInput {
  const record = exactRecord(value, ["plan", "escalationId", "resumeReason"]);
  if (
    !boundedString(record.plan) ||
    !boundedString(record.escalationId) ||
    !boundedTrimmedString(record.resumeReason, 4_096)
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return { plan: record.plan, escalationId: record.escalationId, resumeReason: record.resumeReason };
}

function parsePlanList(value: unknown): PlanListInput {
  const record = exactRecord(value, [], ["filter", "cursor", "limit"]);
  const filter =
    record.filter === undefined ? undefined : parseListFilter(record.filter, ["procedure", "mode", "workState"]);
  if (
    (record.cursor !== undefined && !boundedString(record.cursor, 2_048)) ||
    (record.limit !== undefined && !Number.isSafeInteger(record.limit))
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  if (filter?.mode !== undefined && filter.mode !== "live" && filter.mode !== "dry-run") {
    throw new InvalidPlanRuntimeRpcParams();
  }
  if (filter?.workState !== undefined && !(PLAN_WORK_STATES as readonly string[]).includes(filter.workState)) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    ...(filter === undefined ? {} : { filter: filter as NonNullable<PlanListInput["filter"]> }),
    ...(record.cursor === undefined ? {} : { cursor: record.cursor as string }),
    ...(record.limit === undefined ? {} : { limit: record.limit as number }),
  };
}

function parseHistoryList(value: unknown): HistoryListInput {
  const record = exactRecord(value, [], ["filter", "cursor", "limit"]);
  const filter =
    record.filter === undefined
      ? undefined
      : parseListFilter(record.filter, ["plan", "procedure", "mode", "verdict", "since", "until"]);
  if (
    (record.cursor !== undefined && !boundedString(record.cursor, 2_048)) ||
    (record.limit !== undefined && !Number.isSafeInteger(record.limit))
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  const mode = filter?.mode;
  const verdict = filter?.verdict;
  if (
    (mode !== undefined && mode !== "live" && mode !== "dry-run") ||
    (verdict !== undefined && verdict !== "VALIDATED" && verdict !== "NOT_VALIDATED")
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  const since = filter?.since === undefined ? undefined : normalizedInstant(filter.since);
  const until = filter?.until === undefined ? undefined : normalizedInstant(filter.until);
  return {
    ...(filter === undefined
      ? {}
      : {
          filter: {
            ...(filter.plan === undefined ? {} : { plan: filter.plan }),
            ...(filter.procedure === undefined ? {} : { procedure: filter.procedure }),
            ...(mode === undefined ? {} : { mode }),
            ...(verdict === undefined ? {} : { verdict }),
            ...(since === undefined ? {} : { since }),
            ...(until === undefined ? {} : { until }),
          } as NonNullable<HistoryListInput["filter"]>,
        }),
    ...(record.cursor === undefined ? {} : { cursor: record.cursor as string }),
    ...(record.limit === undefined ? {} : { limit: record.limit as number }),
  };
}

function parseListFilter(value: unknown, keys: readonly string[]): Record<string, string> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    Object.values(value).some((entry) => !boundedString(entry))
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return value as Record<string, string>;
}

function normalizedInstant(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new InvalidPlanRuntimeRpcParams();
  return instant.toISOString();
}

function parsePlanRead(value: unknown): { readonly plan: string } {
  const record = exactRecord(value, ["plan"]);
  if (!boundedString(record.plan)) throw new InvalidPlanRuntimeRpcParams();
  return { plan: record.plan };
}

function parsePlanEngagement(value: unknown): PlanEngagementParams {
  // `mode` is optional: absent means a live Plan; "dry-run" engages an operator-driven Plan.
  const record = exactRecord(
    value,
    ["contract", "procedure", "procedureVersion", "plan", "environment", "rootInputs"],
    ["mode", "metadata"],
  );
  if (
    record.contract !== "trust.plan-engagement-request@1" ||
    !boundedString(record.procedure) ||
    !boundedString(record.procedureVersion) ||
    !boundedString(record.plan) ||
    !boundedString(record.environment) ||
    (record.metadata !== undefined && !isRecord(record.metadata)) ||
    !isRecord(record.rootInputs) ||
    (record.mode !== undefined && record.mode !== "live" && record.mode !== "dry-run")
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    contract: record.contract,
    procedure: record.procedure,
    procedureVersion: record.procedureVersion,
    plan: record.plan,
    environment: record.environment,
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    rootInputs: record.rootInputs,
    ...(record.mode === undefined ? {} : { mode: record.mode }),
  };
}

export function parsePlanDeclarationReplacement(value: unknown): PlanDeclarationReplacementInput {
  const record = exactRecord(
    value,
    ["contract", "plan", "expectedRevision", "declarations"],
    ["missionDeclarations", "missionRemovalReason"],
  );
  const missionDeclarations =
    record.missionDeclarations === undefined ? undefined : parseMissionDeclarations(record.missionDeclarations);
  if (
    record.contract !== "trust.plan-declaration-replacement-request@1" ||
    !boundedString(record.plan) ||
    !Number.isSafeInteger(record.expectedRevision) ||
    Number(record.expectedRevision) < 1 ||
    !isRecord(record.declarations) ||
    (record.missionDeclarations !== undefined && missionDeclarations === undefined) ||
    (record.missionRemovalReason !== undefined && typeof record.missionRemovalReason !== "string")
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    contract: record.contract,
    plan: record.plan,
    expectedRevision: record.expectedRevision as number,
    declarations: record.declarations,
    ...(missionDeclarations === undefined ? {} : { missionDeclarations }),
    // A blank reason reaches the runtime, which refuses it with an explicit message.
    ...(record.missionRemovalReason === undefined ? {} : { missionRemovalReason: record.missionRemovalReason }),
  };
}

/** Same Fact batch the runner reports over OTLP, offered at the RPC boundary for operator-driven (dry-run) Plans. */
function parseFactBatch(value: unknown): FactBatchInput {
  const record = exactRecord(value, [
    "contract",
    "attemptKey",
    "attemptHandle",
    "executionId",
    "checkUri",
    "recordedAt",
    "facts",
  ]);
  if (
    record.contract !== "trust.fact-batch-request@1" ||
    !boundedString(record.attemptKey, 256) ||
    !boundedString(record.attemptHandle, 256) ||
    !boundedString(record.executionId, 256) ||
    !boundedString(record.checkUri, 2_048) ||
    !boundedString(record.recordedAt, 64) ||
    !Array.isArray(record.facts) ||
    record.facts.length === 0 ||
    record.facts.some((fact) => !isRecord(fact))
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    attemptKey: record.attemptKey,
    attemptHandle: record.attemptHandle,
    executionId: record.executionId,
    checkUri: record.checkUri,
    recordedAt: record.recordedAt,
    facts: record.facts as readonly RuntimeJsonObject[],
  };
}

function parseCheckRead(value: unknown): CheckReadParams {
  const record = exactRecord(value, ["contract", "checkUri"]);
  if (record.contract !== "trust.check-read-request@1" || !boundedString(record.checkUri, 2_048)) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return { contract: record.contract, checkUri: record.checkUri };
}

function parseCheckAdmission(value: unknown): CheckAttemptAdmissionParams {
  const record = exactRecord(value, ["contract", "attemptKey", "checkUri"], ["reobserve", "intent", "nextIntent"]);
  if (
    record.contract !== "trust.check-admission-request@1" ||
    !boundedString(record.attemptKey, 256) ||
    !boundedString(record.checkUri, 2_048) ||
    (record.reobserve !== undefined && typeof record.reobserve !== "boolean") ||
    (record.intent !== undefined && !boundedString(record.intent, 1_024)) ||
    (record.nextIntent !== undefined && !boundedString(record.nextIntent, 1_024))
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    contract: record.contract,
    attemptKey: record.attemptKey,
    checkUri: record.checkUri,
    ...(record.reobserve === undefined ? {} : { reobserve: record.reobserve }),
    ...(record.intent === undefined ? {} : { intent: record.intent as string }),
    ...(record.nextIntent === undefined ? {} : { nextIntent: record.nextIntent as string }),
  };
}

function parseCheckFinalization(value: unknown): CheckAttemptFinalizationParams {
  const record = exactRecord(value, ["contract", "attemptHandle"]);
  if (record.contract !== "trust.attempt-finalization-request@1" || !boundedString(record.attemptHandle, 256)) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return { contract: record.contract, attemptHandle: record.attemptHandle };
}

function parseCheckInterruption(value: unknown): CheckAttemptInterruptionParams {
  const record = exactRecord(value, ["contract", "attemptHandle"]);
  if (record.contract !== "trust.attempt-interruption-request@1" || !boundedString(record.attemptHandle, 256)) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return { contract: record.contract, attemptHandle: record.attemptHandle };
}

function parseCheckEscalation(value: unknown): CheckEscalationInput {
  const record = exactRecord(value, [
    "contract",
    "checkUri",
    "attemptHandle",
    "blockingReason",
    "forbiddenFurtherAction",
  ]);
  if (
    record.contract !== "trust.check-escalation-request@1" ||
    !boundedString(record.checkUri, 2_048) ||
    !boundedString(record.attemptHandle, 256) ||
    !boundedTrimmedString(record.blockingReason, 4_096) ||
    !boundedTrimmedString(record.forbiddenFurtherAction, 4_096)
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    contract: record.contract,
    checkUri: record.checkUri,
    attemptHandle: record.attemptHandle,
    blockingReason: record.blockingReason,
    forbiddenFurtherAction: record.forbiddenFurtherAction,
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidPlanRuntimeRpcParams();
  const expected = new Set([...keys, ...optional]);
  if (Object.keys(value).some((key) => !expected.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function boundedTrimmedString(value: unknown, maximum: number): value is string {
  return boundedString(value, maximum) && value === value.trim();
}
