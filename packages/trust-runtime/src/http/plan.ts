import type { PlanReader } from "../plan/read.js";
import type { PlanRuntime } from "../plan/runtime.js";
import type {
  CheckAttemptAdmissionInput as CheckAttemptAdmissionParams,
  PlanEngagementInput as PlanEngagementParams,
} from "../plan/runtime.js";

export const PLAN_ENGAGE_METHOD = "plan.engage" as const;
export const PLAN_LIST_METHOD = "plan.list" as const;
export const PLAN_READ_METHOD = "plan.read" as const;
export const SESSION_READ_METHOD = "session.read" as const;
export const CHECK_READ_METHOD = "check.read" as const;
export const CHECK_ATTEMPT_ADMIT_METHOD = "check.attempt.admit" as const;
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
  readonly reason: import("../plan/runtime.js").PlanRuntimeErrorCode;
  readonly message: string;
}

export const PLAN_RUNTIME_RPC_METHODS = [
  PLAN_ENGAGE_METHOD,
  PLAN_LIST_METHOD,
  PLAN_READ_METHOD,
  SESSION_READ_METHOD,
  CHECK_READ_METHOD,
  CHECK_ATTEMPT_ADMIT_METHOD,
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
      parseEmpty(params);
      return {
        contract: "trust.plan-catalog@1",
        plans: await dependencies.planReader.listPlans(),
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

function parseEmpty(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new InvalidPlanRuntimeRpcParams();
  }
}

function parsePlanRead(value: unknown): { readonly plan: string } {
  const record = exactRecord(value, ["plan"]);
  if (!boundedString(record.plan)) throw new InvalidPlanRuntimeRpcParams();
  return { plan: record.plan };
}

function parsePlanEngagement(value: unknown): PlanEngagementParams {
  const record = exactRecord(value, [
    "contract",
    "procedure",
    "procedureVersion",
    "plan",
    "environment",
    "rootInputs",
  ]);
  if (
    record.contract !== "trust.plan-engagement-request@1"
    || !boundedString(record.procedure)
    || !boundedString(record.procedureVersion)
    || !boundedString(record.plan)
    || !boundedString(record.environment)
    || !isRecord(record.rootInputs)
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
  const record = exactRecord(value, ["contract", "attemptKey", "checkUri"]);
  if (
    record.contract !== "trust.check-admission-request@1"
    || !boundedString(record.attemptKey, 256)
    || !boundedString(record.checkUri, 2_048)
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    contract: record.contract,
    attemptKey: record.attemptKey,
    checkUri: record.checkUri,
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

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidPlanRuntimeRpcParams();
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !expected.has(key))
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
