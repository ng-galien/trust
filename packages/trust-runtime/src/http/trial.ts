import type { RuntimeJsonObject } from "../model.js";
import type { RegistryAuthority } from "../skill/authority.js";
import type { TrialService } from "../trial/service.js";

export const TRIAL_START_METHOD = "operation.trial.start" as const;
export const TRIAL_CANCEL_METHOD = "operation.trial.cancel" as const;
export const TRIAL_READ_METHOD = "operation.trial.read" as const;
export const TRIAL_LIST_METHOD = "operation.trial.list" as const;
export const TRIAL_ERROR_CONTRACT = "trust.trial-error@1" as const;

export interface TrialFailureData {
  readonly contract: typeof TRIAL_ERROR_CONTRACT;
  readonly reason: import("../trial/service.js").TrialErrorCode;
  readonly message: string;
  readonly location?: { readonly line: number; readonly column: number };
}

export const TRIAL_RPC_METHODS = [
  TRIAL_START_METHOD,
  TRIAL_CANCEL_METHOD,
  TRIAL_READ_METHOD,
  TRIAL_LIST_METHOD,
] as const;
export type TrialRpcMethod = (typeof TRIAL_RPC_METHODS)[number];

export function isTrialRpcMethod(method: string): method is TrialRpcMethod {
  return (TRIAL_RPC_METHODS as readonly string[]).includes(method);
}

export interface TrialRpcDependencies {
  readonly trialService: TrialService;
  readonly registryAuthority: RegistryAuthority;
}

export interface TrialRpcContext {
  readonly authorizationHeader?: string;
}

export class InvalidTrialRpcParams extends Error {
  constructor() {
    super("invalid trial RPC params");
    this.name = "InvalidTrialRpcParams";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function executeTrialRpc(method: TrialRpcMethod, params: unknown, dependencies: TrialRpcDependencies, context: TrialRpcContext): unknown {
  const authorize = (roles: Array<"observer" | "operator" | "publisher">) =>
    dependencies.registryAuthority.authorize({
      ...(context.authorizationHeader === undefined ? {} : { authorizationHeader: context.authorizationHeader }),
      anyRoleOf: roles,
    });

  switch (method) {
    case TRIAL_START_METHOD: {
      if (!isRecord(params) || typeof params.environment !== "string" || !isRecord(params.input)) throw new InvalidTrialRpcParams();
      const hasSource = typeof params.source === "string";
      const hasOperation = typeof params.operation === "string";
      if (hasSource === hasOperation) throw new InvalidTrialRpcParams();
      if (params.version !== undefined && typeof params.version !== "string") throw new InvalidTrialRpcParams();
      const principal = authorize(["operator", "publisher"]);
      const summary = dependencies.trialService.start({
        ...(hasSource ? { source: params.source as string } : { operation: params.operation as string, ...(typeof params.version === "string" ? { version: params.version } : {}) }),
        environment: params.environment,
        input: params.input as RuntimeJsonObject,
        startedBy: principal.identity,
      });
      return { contract: "trust.trial-summary@1", trial: summary };
    }
    case TRIAL_CANCEL_METHOD: {
      if (!isRecord(params) || Object.keys(params).length !== 1 || typeof params.trial !== "string" || params.trial === "") throw new InvalidTrialRpcParams();
      authorize(["operator", "publisher"]);
      return { contract: "trust.trial-summary@1", trial: dependencies.trialService.cancel(params.trial) };
    }
    case TRIAL_READ_METHOD: {
      if (!isRecord(params) || typeof params.trial !== "string") throw new InvalidTrialRpcParams();
      authorize(["observer", "operator", "publisher"]);
      const trial = dependencies.trialService.read(params.trial);
      const after = typeof params.after === "number" ? params.after : 0;
      return {
        contract: "trust.trial-view@1",
        trial: {
          id: trial.id,
          operation: trial.operation,
          version: trial.version,
          environment: trial.environment,
          input: trial.input,
          startedAt: trial.startedAt,
          startedBy: trial.startedBy,
          status: trial.status,
          ...(trial.endedAt ? { endedAt: trial.endedAt } : {}),
          ...(trial.error ? { error: trial.error } : {}),
          ...(trial.outcome ? { outcome: trial.outcome } : {}),
          events: trial.events.filter((event) => event.sequence > after),
        },
      };
    }
    case TRIAL_LIST_METHOD: {
      if (params !== undefined && !isRecord(params)) throw new InvalidTrialRpcParams();
      if (isRecord(params) && params.operation !== undefined && typeof params.operation !== "string") throw new InvalidTrialRpcParams();
      authorize(["observer", "operator", "publisher"]);
      return { contract: "trust.trial-catalog@1", trials: dependencies.trialService.list(isRecord(params) ? (params.operation as string | undefined) : undefined) };
    }
  }
}
