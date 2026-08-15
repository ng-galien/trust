import type { PlanReader } from "../plan/read.js";
import type { PlanRuntime } from "../plan/runtime.js";
import type { RegistryAuthority } from "../skill/authority.js";
import type {
  CheckAttemptAdmissionInput as CheckAttemptAdmissionParams,
  PlanEngagementInput as PlanEngagementParams,
  SkillAttemptAdmissionInput as SkillAttemptAdmissionParams,
} from "../plan/runtime.js";

export const PLAN_ENGAGE_METHOD = "plan.engage" as const;
export const CHECK_READ_METHOD = "check.read" as const;
export const CHECK_ATTEMPT_ADMIT_METHOD = "check.attempt.admit" as const;
export const CHECK_ATTEMPT_FINALIZE_METHOD = "check.attempt.finalize" as const;
export const SKILL_ATTEMPT_ADMIT_METHOD = "skill.attempt.admit" as const;
export const SKILL_ATTEMPT_FINALIZE_METHOD = "skill.attempt.finalize" as const;
export const PLAN_RUNTIME_ERROR_CONTRACT = "trust.plan-runtime-error@1" as const;

interface CheckReadParams {
  readonly contract: "trust.check-read-request@1";
  readonly checkUri: string;
}

interface CheckAttemptFinalizationParams {
  readonly contract: "trust.attempt-finalization-request@1";
  readonly attemptHandle: string;
}

type SkillAttemptFinalizationParams = CheckAttemptFinalizationParams;

export interface PlanRuntimeFailureData {
  readonly contract: typeof PLAN_RUNTIME_ERROR_CONTRACT;
  readonly reason: import("../plan/runtime.js").PlanRuntimeErrorCode;
  readonly message: string;
}

export const PLAN_RUNTIME_RPC_METHODS = [
  PLAN_ENGAGE_METHOD,
  CHECK_READ_METHOD,
  CHECK_ATTEMPT_ADMIT_METHOD,
  CHECK_ATTEMPT_FINALIZE_METHOD,
  SKILL_ATTEMPT_ADMIT_METHOD,
  SKILL_ATTEMPT_FINALIZE_METHOD,
] as const;

export type PlanRuntimeRpcMethod = (typeof PLAN_RUNTIME_RPC_METHODS)[number];

export interface PlanRuntimeRpcDependencies {
  readonly planReader: PlanReader;
  readonly planRuntime: PlanRuntime;
  readonly registryAuthority: RegistryAuthority;
}

export interface PlanRuntimeRpcContext {
  readonly authorizationHeader?: string;
  readonly processAuthorizationHeader?: string;
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

export function executePlanRuntimeRpc(
  method: PlanRuntimeRpcMethod,
  params: unknown,
  dependencies: PlanRuntimeRpcDependencies,
  context: PlanRuntimeRpcContext,
): unknown {
  switch (method) {
    case PLAN_ENGAGE_METHOD: {
      const input = parsePlanEngagement(params);
      dependencies.registryAuthority.authorize({
        ...(context.authorizationHeader === undefined
          ? {}
          : { authorizationHeader: context.authorizationHeader }),
        anyRoleOf: ["operator"],
      });
      return dependencies.planRuntime.engage(input);
    }
    case CHECK_READ_METHOD: {
      const input = parseCheckRead(params);
      dependencies.registryAuthority.authorize({
        ...(context.authorizationHeader === undefined
          ? {}
          : { authorizationHeader: context.authorizationHeader }),
        anyRoleOf: ["observer", "operator"],
      });
      const view = dependencies.planReader.readCheck(input.checkUri);
      return {
        contract: "trust.check-view@1",
        checkUri: view.checkUri,
        state: view.state,
        history: view.history,
      };
    }
    case CHECK_ATTEMPT_ADMIT_METHOD: {
      const input = parseCheckAdmission(params);
      return dependencies.planRuntime.admitCheck(input);
    }
    case CHECK_ATTEMPT_FINALIZE_METHOD: {
      const input = parseCheckFinalization(params);
      return dependencies.planRuntime.finalizeCheck(input.attemptHandle);
    }
    case SKILL_ATTEMPT_ADMIT_METHOD: {
      const input = parseAdmission(params);
      dependencies.registryAuthority.authorize({
        ...(context.authorizationHeader === undefined
          ? {}
          : { authorizationHeader: context.authorizationHeader }),
        anyRoleOf: ["runtime"],
        assertedIdentity: input.runtimeIdentity,
      });
      dependencies.registryAuthority.authorize({
        ...(context.processAuthorizationHeader === undefined
          ? {}
          : { authorizationHeader: context.processAuthorizationHeader }),
        anyRoleOf: ["runtime-process"],
        assertedIdentity: input.processIdentity,
      });
      return dependencies.planRuntime.admitSkill(input);
    }
    case SKILL_ATTEMPT_FINALIZE_METHOD: {
      const input = parseFinalization(params);
      const runtime = dependencies.registryAuthority.authorize({
        ...(context.authorizationHeader === undefined
          ? {}
          : { authorizationHeader: context.authorizationHeader }),
        anyRoleOf: ["runtime"],
      });
      const process = dependencies.registryAuthority.authorize({
        ...(context.processAuthorizationHeader === undefined
          ? {}
          : { authorizationHeader: context.processAuthorizationHeader }),
        anyRoleOf: ["runtime-process"],
      });
      return dependencies.planRuntime.finalizeSkill(input.attemptHandle, {
        runtimeIdentity: runtime.identity,
        processIdentity: process.identity,
      });
    }
  }
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

function parseAdmission(value: unknown): SkillAttemptAdmissionParams {
  const record = exactRecord(value, [
    "contract",
    "attemptKey",
    "checkUri",
    "releaseDigest",
    "environment",
    "deploymentKey",
    "envelope",
    "runtimeIdentity",
    "processIdentity",
  ]);
  if (
    record.contract !== "trust.skill-admission-request@1"
    || !boundedString(record.attemptKey, 256)
    || !boundedString(record.checkUri, 2_048)
    || typeof record.releaseDigest !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(record.releaseDigest)
    || !boundedString(record.environment)
    || !boundedString(record.deploymentKey)
    || (record.envelope !== "cli"
      && record.envelope !== "mcp-stdio"
      && record.envelope !== "mcp-http")
    || !boundedString(record.runtimeIdentity, 2_048)
    || !boundedString(record.processIdentity, 2_048)
  ) {
    throw new InvalidPlanRuntimeRpcParams();
  }
  return {
    contract: record.contract,
    attemptKey: record.attemptKey,
    checkUri: record.checkUri,
    releaseDigest: record.releaseDigest,
    environment: record.environment,
    deploymentKey: record.deploymentKey,
    envelope: record.envelope,
    runtimeIdentity: record.runtimeIdentity,
    processIdentity: record.processIdentity,
  };
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

function parseFinalization(value: unknown): SkillAttemptFinalizationParams {
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
