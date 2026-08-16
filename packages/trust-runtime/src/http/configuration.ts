import type { CredentialService } from "../credential/service.js";
import type { EnvironmentService } from "../environment/service.js";
import type { RegistryAuthority } from "../skill/authority.js";
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
  readonly registryAuthority: RegistryAuthority;
}

export interface ConfigurationRpcContext {
  readonly authorizationHeader?: string;
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
  context: ConfigurationRpcContext,
): Promise<unknown> {
  const authorize = (roles: Array<"observer" | "operator" | "publisher">) =>
    dependencies.registryAuthority.authorize({
      ...(context.authorizationHeader === undefined ? {} : { authorizationHeader: context.authorizationHeader }),
      anyRoleOf: roles,
    });

  switch (method) {
    case OPERATION_ENVIRONMENTS_METHOD: {
      if (params !== undefined && !(isRecord(params) && Object.keys(params).length === 0)) invalid();
      authorize(["observer", "operator", "publisher"]);
      return { contract: "trust.operation-environments@1", operations: dependencies.trialService.catalogEnvironments() };
    }
    case ENVIRONMENT_LIST_METHOD: {
      if (params !== undefined && !isRecord(params)) invalid();
      authorize(["observer", "operator", "publisher"]);
      const scoped = isRecord(params) && (typeof params.operation === "string" || typeof params.source === "string");
      if (scoped) {
        if (params.version !== undefined && typeof params.version !== "string") invalid();
        return {
          contract: "trust.environment-catalog@1",
          environments: dependencies.trialService.environmentsFor({
            ...(typeof params.operation === "string" ? { operation: params.operation } : {}),
            ...(typeof params.version === "string" ? { version: params.version } : {}),
            ...(typeof params.source === "string" ? { source: params.source } : {}),
          }),
        };
      }
      if (isRecord(params) && Object.keys(params).length > 0) invalid();
      return { contract: "trust.environment-catalog@1", environments: dependencies.trialService.environments() };
    }
    case ENVIRONMENT_SAVE_METHOD: {
      if (
        !isRecord(params)
        || !hasOnlyKeys(params, ["environment", "values"])
        || typeof params.environment !== "string"
        || !stringValues(params.values)
      ) invalid();
      authorize(["operator", "publisher"]);
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
      authorize(["operator", "publisher"]);
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
      authorize(["observer", "operator", "publisher"]);
      return {
        contract: "trust.credential-catalog@1",
        credentials: dependencies.credentialService.list(
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
      authorize(["operator", "publisher"]);
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
      authorize(["operator", "publisher"]);
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
