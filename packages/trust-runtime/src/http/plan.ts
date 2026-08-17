import type { HistoryListInput, PlanListInput, PlanReader, ReadErrorCode } from "../plan/read.js";
import type { PlanRuntime } from "../plan/runtime.js";
import type {
  CheckAttemptAdmissionInput as CheckAttemptAdmissionParams,
  FactBatchInput,
  PlanDeclarationReplacementInput,
  PlanEngagementInput as PlanEngagementParams,
} from "../plan/runtime.js";
import type { RuntimeJsonObject } from "../model.js";

export const PLAN_ENGAGE_METHOD = "plan.engage" as const;
export const PLAN_LIST_METHOD = "plan.list" as const;
export const HISTORY_LIST_METHOD = "history.list" as const;
export const PLAN_READ_METHOD = "plan.read" as const;
export const SESSION_READ_METHOD = "session.read" as const;
export const CHECK_READ_METHOD = "check.read" as const;
export const PLAN_DECLARATIONS_REPLACE_METHOD = "plan.declarations.replace" as const;
export const PLAN_REMOVE_METHOD = "plan.remove" as const;
export const PLAN_CLOSE_METHOD = "plan.close" as const;
export const CHECK_ATTEMPT_ADMIT_METHOD = "check.attempt.admit" as const;
export const CHECK_ATTEMPT_FACTS_METHOD = "check.attempt.facts" as const;
export const CHECK_ATTEMPT_FINALIZE_METHOD = "check.attempt.finalize" as const;
export const PLAN_RUNTIME_ERROR_CONTRACT = "trust.plan-runtime-error@1" as const;

interface CheckReadParams {
  readonly contract: "trust.check-read-request@1";
  readonly checkUri: string;
}

interface CheckAttemptFinalizationParams {
  readonly contract: "trust.attempt-finalization-request@1";
  readonly attemptHandle: string;
}

export interface PlanRuntimeFailureData {
  readonly contract: typeof PLAN_RUNTIME_ERROR_CONTRACT;
  readonly reason: import("../plan/runtime.js").PlanRuntimeErrorCode | ReadErrorCode;
  readonly message: string;
}

export const PLAN_RUNTIME_RPC_METHODS = [
  PLAN_ENGAGE_METHOD,
  PLAN_LIST_METHOD,
  HISTORY_LIST_METHOD,
  PLAN_READ_METHOD,
  PLAN_DECLARATIONS_REPLACE_METHOD,
  PLAN_REMOVE_METHOD,
  PLAN_CLOSE_METHOD,
  SESSION_READ_METHOD,
  CHECK_READ_METHOD,
  CHECK_ATTEMPT_ADMIT_METHOD,
  CHECK_ATTEMPT_FACTS_METHOD,
  CHECK_ATTEMPT_FINALIZE_METHOD,
] as const;

export type PlanRuntimeRpcMethod = (typeof PLAN_RUNTIME_RPC_METHODS)[number];

export interface PlanRuntimeRpcDependencies {
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
        ...await dependencies.planReader.listPlans(parsePlanList(params)),
      };
    case HISTORY_LIST_METHOD:
      return {
        contract: "trust.check-history@1",
        ...await dependencies.planReader.listHistory(parseHistoryList(params)),
      };
    case PLAN_READ_METHOD: {
      const input = parsePlanRead(params);
      return {
        contract: "trust.plan-view@1",
        ...await dependencies.planReader.readPlanBySlug(input.plan),
      };
    }
    case SESSION_READ_METHOD: {
      const input = parsePlanRead(params);
      const plan = await dependencies.planReader.readPlanBySlug(input.plan);
      return {
        contract: "trust.session-view@1",
        plan: plan.plan,
        state: plan.sessionState,
        activeRevision: plan.revision,
        workState: plan.workState,
        checklistComplete: plan.checklistComplete,
        satisfiedChecks: plan.satisfiedChecks,
        openChecks: plan.openChecks.length,
        sessions: plan.sessions,
      };
    }
    case PLAN_ENGAGE_METHOD: {
      const input = parsePlanEngagement(params);
      return dependencies.planRuntime.engage(input);
    }
    case PLAN_REMOVE_METHOD: {
      const input = parsePlanRead(params);
      return dependencies.planRuntime.remove(input.plan);
    }
    case PLAN_CLOSE_METHOD: {
      const input = parsePlanRead(params);
      return dependencies.planRuntime.close(input.plan);
    }
    case PLAN_DECLARATIONS_REPLACE_METHOD: {
      const input = parsePlanDeclarationReplacement(params);
      return dependencies.planRuntime.replaceDeclarations(input);
    }
    case CHECK_ATTEMPT_FACTS_METHOD: {
      const input = parseFactBatch(params);
      return dependencies.planRuntime.ingestDryRunFacts(input);
    }
    case CHECK_READ_METHOD: {
      const input = parseCheckRead(params);
      const view = await dependencies.planReader.readCheck(input.checkUri);
      return { contract: "trust.check-view@1", ...view };
    }
    case CHECK_ATTEMPT_ADMIT_METHOD: {
      const input = parseCheckAdmission(params);
      return dependencies.planRuntime.admitCheck(input);
    }
    case CHECK_ATTEMPT_FINALIZE_METHOD: {
      const input = parseCheckFinalization(params);
      return dependencies.planRuntime.finalizeCheck(input.attemptHandle);
    }
  }
}

function parsePlanList(value: unknown): PlanListInput {
  const record = exactRecord(value, [], ["filter", "cursor", "limit"]);
  const filter = record.filter === undefined
    ? undefined
    : parseListFilter(record.filter, ["procedure", "mode"]);
  if ((record.cursor !== undefined && !boundedString(record.cursor, 2_048))
    || (record.limit !== undefined && !Number.isSafeInteger(record.limit))) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  if (filter?.mode !== undefined && filter.mode !== "live" && filter.mode !== "dry-run") {
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
  const filter = record.filter === undefined
    ? undefined
    : parseListFilter(record.filter, ["plan", "procedure", "mode", "verdict", "since", "until"]);
  if ((record.cursor !== undefined && !boundedString(record.cursor, 2_048))
    || (record.limit !== undefined && !Number.isSafeInteger(record.limit))) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  const mode = filter?.mode;
  const verdict = filter?.verdict;
  if ((mode !== undefined && mode !== "live" && mode !== "dry-run")
    || (verdict !== undefined && verdict !== "VALIDATED" && verdict !== "NOT_VALIDATED")) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  const since = filter?.since === undefined ? undefined : normalizedInstant(filter.since);
  const until = filter?.until === undefined ? undefined : normalizedInstant(filter.until);
  return {
    ...(filter === undefined ? {} : { filter: {
      ...(filter.plan === undefined ? {} : { plan: filter.plan }),
      ...(filter.procedure === undefined ? {} : { procedure: filter.procedure }),
      ...(mode === undefined ? {} : { mode }),
      ...(verdict === undefined ? {} : { verdict }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    } as NonNullable<HistoryListInput["filter"]> }),
    ...(record.cursor === undefined ? {} : { cursor: record.cursor as string }),
    ...(record.limit === undefined ? {} : { limit: record.limit as number }),
  };
}

function parseListFilter(value: unknown, keys: readonly string[]): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))
    || Object.values(value).some((entry) => !boundedString(entry))) {
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
  const record = exactRecord(value, [
    "contract",
    "procedure",
    "procedureVersion",
    "plan",
    "environment",
    "rootInputs",
  ], ["mode"]);
  if (
    record.contract !== "trust.plan-engagement-request@1"
    || !boundedString(record.procedure)
    || !boundedString(record.procedureVersion)
    || !boundedString(record.plan)
    || !boundedString(record.environment)
    || !isRecord(record.rootInputs)
    || (record.mode !== undefined && record.mode !== "live" && record.mode !== "dry-run")
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    contract: record.contract,
    procedure: record.procedure,
    procedureVersion: record.procedureVersion,
    plan: record.plan,
    environment: record.environment,
    rootInputs: record.rootInputs,
    ...(record.mode === undefined ? {} : { mode: record.mode }),
  };
}

function parsePlanDeclarationReplacement(value: unknown): PlanDeclarationReplacementInput {
  const record = exactRecord(value, ["contract", "plan", "expectedRevision", "declarations"]);
  if (
    record.contract !== "trust.plan-declaration-replacement-request@1"
    || !boundedString(record.plan)
    || !Number.isSafeInteger(record.expectedRevision)
    || Number(record.expectedRevision) < 1
    || !isRecord(record.declarations)
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    contract: record.contract,
    plan: record.plan,
    expectedRevision: record.expectedRevision as number,
    declarations: record.declarations,
  };
}

/** Same Fact batch the runner reports over OTLP, offered at the RPC boundary for operator-driven (dry-run) Plans. */
function parseFactBatch(value: unknown): FactBatchInput {
  const record = exactRecord(value, ["contract", "attemptKey", "attemptHandle", "checkUri", "recordedAt", "facts"]);
  if (
    record.contract !== "trust.fact-batch-request@1"
    || !boundedString(record.attemptKey, 256)
    || !boundedString(record.attemptHandle, 256)
    || !boundedString(record.checkUri, 2_048)
    || !boundedString(record.recordedAt, 64)
    || !Array.isArray(record.facts)
    || record.facts.length === 0
    || record.facts.some((fact) => !isRecord(fact))
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    attemptKey: record.attemptKey,
    attemptHandle: record.attemptHandle,
    checkUri: record.checkUri,
    recordedAt: record.recordedAt,
    facts: record.facts as readonly RuntimeJsonObject[],
  };
}

function parseCheckRead(value: unknown): CheckReadParams {
  const record = exactRecord(value, ["contract", "checkUri"]);
  if (
    record.contract !== "trust.check-read-request@1"
    || !boundedString(record.checkUri, 2_048)
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return { contract: record.contract, checkUri: record.checkUri };
}

function parseCheckAdmission(value: unknown): CheckAttemptAdmissionParams {
  const record = exactRecord(value, ["contract", "attemptKey", "checkUri"], ["reobserve"]);
  if (
    record.contract !== "trust.check-admission-request@1"
    || !boundedString(record.attemptKey, 256)
    || !boundedString(record.checkUri, 2_048)
    || (record.reobserve !== undefined && typeof record.reobserve !== "boolean")
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    contract: record.contract,
    attemptKey: record.attemptKey,
    checkUri: record.checkUri,
    ...(record.reobserve === undefined ? {} : { reobserve: record.reobserve }),
  };
}

function parseCheckFinalization(value: unknown): CheckAttemptFinalizationParams {
  const record = exactRecord(value, ["contract", "attemptHandle"]);
  if (
    record.contract !== "trust.attempt-finalization-request@1"
    || !boundedString(record.attemptHandle, 256)
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return { contract: record.contract, attemptHandle: record.attemptHandle };
}

function exactRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidPlanRuntimeRpcParams();
  const expected = new Set([...keys, ...optional]);
  if (
    Object.keys(value).some((key) => !expected.has(key))
    || keys.some((key) => !Object.hasOwn(value, key))
  ) {
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
