import type { CredentialService } from "../credential/service.js";
import type { EnvironmentService } from "../environment/service.js";
import type { TrialService } from "../trial/service.js";

export const ENVIRONMENT_LIST_METHOD = "environment.list" as const;
export const ENVIRONMENT_SAVE_METHOD = "environment.save" as const;
export const ENVIRONMENT_REMOVE_METHOD = "environment.remove" as const;
export const CREDENTIAL_LIST_METHOD = "credential.list" as const;
export const CREDENTIAL_SAVE_METHOD = "credential.save" as const;
export const CREDENTIAL_REMOVE_METHOD = "credential.remove" as const;
export const OPERATION_ENVIRONMENTS_METHOD = "operation.environments" as const;

export const CONFIGURATION_RPC_METHODS = [
  ENVIRONMENT_LIST_METHOD,
  ENVIRONMENT_SAVE_METHOD,
  ENVIRONMENT_REMOVE_METHOD,
  CREDENTIAL_LIST_METHOD,
  CREDENTIAL_SAVE_METHOD,
  CREDENTIAL_REMOVE_METHOD,
  OPERATION_ENVIRONMENTS_METHOD,
] as const;

export type ConfigurationRpcMethod = (typeof CONFIGURATION_RPC_METHODS)[number];

export interface ConfigurationRpcDependencies {
  readonly trialService: TrialService;
  readonly environmentService: EnvironmentService;
  readonly credentialService: CredentialService;
}

export class InvalidConfigurationRpcParams extends Error {
  constructor() {
    super("invalid configuration RPC params");
    this.name = "InvalidConfigurationRpcParams";
  }
}

export function isConfigurationRpcMethod(method: string): method is ConfigurationRpcMethod {
  return (CONFIGURATION_RPC_METHODS as readonly string[]).includes(method);
}

export async function executeConfigurationRpc(
  method: ConfigurationRpcMethod,
  params: unknown,
  dependencies: ConfigurationRpcDependencies,
): Promise<unknown> {
  switch (method) {
    case OPERATION_ENVIRONMENTS_METHOD: {
      if (params !== undefined && !(isRecord(params) && Object.keys(params).length === 0)) invalid();
      return { contract: "trust.operation-environments@1", operations: dependencies.trialService.catalogEnvironments() };
    }
    case ENVIRONMENT_LIST_METHOD: {
      if (params === undefined || (isRecord(params) && Object.keys(params).length === 0)) {
        return { contract: "trust.environment-catalog@1", environments: dependencies.trialService.environments() };
      }
      if (!isRecord(params)) invalid();
      const hasOperation = typeof params.operation === "string" && params.operation.length > 0;
      const hasSource = typeof params.source === "string" && params.source.length > 0;
      if (hasOperation === hasSource) invalid();
      if (hasSource) {
        if (!hasOnlyKeys(params, ["source"])) invalid();
        return {
          contract: "trust.environment-catalog@1",
          environments: dependencies.trialService.environmentsFor({ source: params.source as string }),
        };
      }
      if (!hasOnlyKeys(params, ["operation", "version"])
        || (params.version !== undefined && (typeof params.version !== "string" || params.version.length === 0))) invalid();
      return {
        contract: "trust.environment-catalog@1",
        environments: dependencies.trialService.environmentsFor({
          operation: params.operation as string,
          ...(typeof params.version === "string" ? { version: params.version } : {}),
        }),
      };
    }
    case ENVIRONMENT_SAVE_METHOD: {
      if (
        !isRecord(params)
        || !hasOnlyKeys(params, ["environment", "values"])
        || typeof params.environment !== "string"
        || !stringValues(params.values)
      ) invalid();
      return {
        contract: "trust.environment@1",
        environment: await dependencies.environmentService.save(params.environment, params.values),
      };
    }
    case ENVIRONMENT_REMOVE_METHOD: {
      if (
        !isRecord(params)
        || !hasOnlyKeys(params, ["environment"])
        || typeof params.environment !== "string"
      ) invalid();
      return {
        contract: "trust.environment-removal@1",
        environment: params.environment,
        removed: await dependencies.environmentService.remove(params.environment),
      };
    }
    case CREDENTIAL_LIST_METHOD: {
      if (params !== undefined && !isRecord(params)) invalid();
      if (
        isRecord(params)
        && (!hasOnlyKeys(params, ["environment"])
          || (params.environment !== undefined && typeof params.environment !== "string"))
      ) invalid();
      return {
        contract: "trust.credential-catalog@1",
        credentials: await dependencies.credentialService.list(
          isRecord(params) && typeof params.environment === "string" ? params.environment : undefined,
        ),
      };
    }
    case CREDENTIAL_SAVE_METHOD: {
      if (
        !isRecord(params)
        || !hasOnlyKeys(params, ["environment", "name", "value"])
        || typeof params.environment !== "string"
        || typeof params.name !== "string"
        || typeof params.value !== "string"
      ) invalid();
      return {
        contract: "trust.credential@1",
        credential: await dependencies.credentialService.save(params.environment, params.name, params.value),
      };
    }
    case CREDENTIAL_REMOVE_METHOD: {
      if (
        !isRecord(params)
        || !hasOnlyKeys(params, ["environment", "name"])
        || typeof params.environment !== "string"
        || typeof params.name !== "string"
      ) invalid();
      return {
        contract: "trust.credential-removal@1",
        environment: params.environment,
        name: params.name,
        removed: await dependencies.credentialService.remove(params.environment, params.name),
      };
    }
  }
}

function invalid(): never {
  throw new InvalidConfigurationRpcParams();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function stringValues(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
