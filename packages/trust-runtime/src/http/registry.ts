import type { RegistryService } from "../registry/service.js";
import type { RegistrySourceInput } from "../registry/store.js";

export const REGISTRY_SOURCE_LIST_METHOD = "registry.source.list" as const;
export const REGISTRY_SOURCE_SAVE_METHOD = "registry.source.save" as const;
export const REGISTRY_SOURCE_REMOVE_METHOD = "registry.source.remove" as const;
export const REGISTRY_SOURCE_SYNC_METHOD = "registry.source.sync" as const;

export const REGISTRY_RPC_METHODS = [
  REGISTRY_SOURCE_LIST_METHOD,
  REGISTRY_SOURCE_SAVE_METHOD,
  REGISTRY_SOURCE_REMOVE_METHOD,
  REGISTRY_SOURCE_SYNC_METHOD,
] as const;

export type RegistryRpcMethod = (typeof REGISTRY_RPC_METHODS)[number];

export interface RegistryRpcDependencies {
  readonly registryService: RegistryService;
}

export class InvalidRegistryRpcParams extends Error {
  constructor() {
    super("invalid registry RPC params");
    this.name = "InvalidRegistryRpcParams";
  }
}

export function isRegistryRpcMethod(method: string): method is RegistryRpcMethod {
  return (REGISTRY_RPC_METHODS as readonly string[]).includes(method);
}

export async function executeRegistryRpc(
  method: RegistryRpcMethod,
  params: unknown,
  dependencies: RegistryRpcDependencies,
): Promise<unknown> {
  switch (method) {
    case REGISTRY_SOURCE_LIST_METHOD: {
      if (params !== undefined && !(isRecord(params) && Object.keys(params).length === 0)) invalid();
      return {
        contract: "trust.registry-source-catalog@1",
        sources: await dependencies.registryService.list(),
      };
    }
    case REGISTRY_SOURCE_SAVE_METHOD: {
      const source = sourceParams(params);
      if (source === undefined) invalid();
      return {
        contract: "trust.registry-source@1",
        source: await dependencies.registryService.save(source),
      };
    }
    case REGISTRY_SOURCE_REMOVE_METHOD: {
      const name = nameParams(params);
      if (name === undefined) invalid();
      return {
        contract: "trust.registry-source-removal@1",
        name,
        removed: await dependencies.registryService.remove(name),
      };
    }
    case REGISTRY_SOURCE_SYNC_METHOD: {
      const name = nameParams(params);
      if (name === undefined) invalid();
      return await dependencies.registryService.sync(name);
    }
  }
}

function sourceParams(value: unknown): RegistrySourceInput | undefined {
  if (!isRecord(value)
    || typeof value.name !== "string"
    || typeof value.url !== "string"
    || (value.kind !== "git" && value.kind !== "http")) return undefined;
  if (value.kind === "http") {
    if (!hasOnlyKeys(value, ["name", "kind", "url"])) return undefined;
    return { name: value.name, kind: "http", url: value.url };
  }
  if (!hasOnlyKeys(value, ["name", "kind", "url", "reference"])
    || (value.reference !== undefined && typeof value.reference !== "string")) return undefined;
  return {
    name: value.name,
    kind: "git",
    url: value.url,
    ...(typeof value.reference === "string" ? { reference: value.reference } : {}),
  };
}

function nameParams(value: unknown): string | undefined {
  return isRecord(value) && hasOnlyKeys(value, ["name"]) && typeof value.name === "string"
    ? value.name
    : undefined;
}

function invalid(): never {
  throw new InvalidRegistryRpcParams();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
