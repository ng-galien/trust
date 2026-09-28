import {
  EXTENSION_CAPABILITIES,
  type ExtensionCapability,
  type ExtensionSettingsValues,
  type RegistryPackageInstallRequest,
  type RegistryPackageUninstallRequest,
  type RegistryPackageUpdateRequest,
  type RegistrySourceInput,
} from "@trust/extension-sdk";

import type { RegistryPackages } from "../registry/packages.js";
import type { RegistryService } from "../registry/service.js";

export const REGISTRY_SOURCE_LIST_METHOD = "registry.source.list" as const;
export const REGISTRY_SOURCE_SAVE_METHOD = "registry.source.save" as const;
export const REGISTRY_SOURCE_REMOVE_METHOD = "registry.source.remove" as const;
export const REGISTRY_SOURCE_SYNC_METHOD = "registry.source.sync" as const;
export const REGISTRY_SOURCE_REFRESH_METHOD = "registry.source.refresh" as const;
export const REGISTRY_SOURCE_READ_METHOD = "registry.source.read" as const;
export const REGISTRY_PACKAGE_LIST_METHOD = "registry.package.list" as const;
export const REGISTRY_PACKAGE_INSTALL_METHOD = "registry.package.install" as const;
export const REGISTRY_PACKAGE_UPDATE_METHOD = "registry.package.update" as const;
export const REGISTRY_PACKAGE_UNINSTALL_METHOD = "registry.package.uninstall" as const;

export const REGISTRY_RPC_METHODS = [
  REGISTRY_SOURCE_LIST_METHOD,
  REGISTRY_SOURCE_SAVE_METHOD,
  REGISTRY_SOURCE_REMOVE_METHOD,
  REGISTRY_SOURCE_SYNC_METHOD,
  REGISTRY_SOURCE_REFRESH_METHOD,
  REGISTRY_SOURCE_READ_METHOD,
  REGISTRY_PACKAGE_LIST_METHOD,
  REGISTRY_PACKAGE_INSTALL_METHOD,
  REGISTRY_PACKAGE_UPDATE_METHOD,
  REGISTRY_PACKAGE_UNINSTALL_METHOD,
] as const;

export type RegistryRpcMethod = (typeof REGISTRY_RPC_METHODS)[number];

export interface RegistryRpcDependencies {
  readonly registryService: RegistryService;
  readonly registryPackages: RegistryPackages;
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

/** One runtime function per method; RPC and MCP both call this dispatcher with the same closed params. */
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
    case REGISTRY_SOURCE_REMOVE_METHOD:
      return dependencies.registryService.remove(nameParams(params));
    case REGISTRY_SOURCE_SYNC_METHOD:
      return dependencies.registryService.sync(nameParams(params));
    case REGISTRY_SOURCE_REFRESH_METHOD:
      return dependencies.registryService.refresh(nameParams(params));
    case REGISTRY_SOURCE_READ_METHOD:
      return dependencies.registryService.read(nameParams(params));
    case REGISTRY_PACKAGE_LIST_METHOD: {
      if (params !== undefined && !(isRecord(params) && Object.keys(params).length === 0)) invalid();
      return dependencies.registryPackages.list();
    }
    case REGISTRY_PACKAGE_INSTALL_METHOD:
      return dependencies.registryPackages.install(installParams(params));
    case REGISTRY_PACKAGE_UPDATE_METHOD:
      return dependencies.registryPackages.update(updateParams(params));
    case REGISTRY_PACKAGE_UNINSTALL_METHOD:
      return dependencies.registryPackages.uninstall(uninstallParams(params));
  }
}

function sourceParams(value: unknown): RegistrySourceInput | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.url !== "string" ||
    (value.kind !== "git" && value.kind !== "http" && value.kind !== "file")
  )
    return undefined;
  if (value.kind !== "git") {
    if (!hasOnlyKeys(value, ["name", "kind", "url"])) return undefined;
    return { name: value.name, kind: value.kind, url: value.url };
  }
  if (
    !hasOnlyKeys(value, ["name", "kind", "url", "reference"]) ||
    (value.reference !== undefined && typeof value.reference !== "string")
  )
    return undefined;
  return {
    name: value.name,
    kind: "git",
    url: value.url,
    ...(typeof value.reference === "string" ? { reference: value.reference } : {}),
  };
}

function nameParams(value: unknown): string {
  if (!isRecord(value) || !hasOnlyKeys(value, ["name"]) || typeof value.name !== "string") invalid();
  return value.name;
}

function packageName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) invalid();
  return value;
}

function version(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) invalid();
  return value;
}

function grants(value: unknown): readonly ExtensionCapability[] {
  if (!Array.isArray(value) || value.some((grant) => !(EXTENSION_CAPABILITIES as readonly unknown[]).includes(grant)))
    invalid();
  return value as ExtensionCapability[];
}

function settings(value: unknown): ExtensionSettingsValues {
  if (!isRecord(value)) invalid();
  return value as ExtensionSettingsValues;
}

function installParams(value: unknown): RegistryPackageInstallRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["source", "package", "version", "extension"]) ||
    typeof value.source !== "string"
  )
    invalid();
  let extension: RegistryPackageInstallRequest["extension"];
  if (value.extension !== undefined) {
    const raw = value.extension;
    if (
      !isRecord(raw) ||
      !hasOnlyKeys(raw, ["environment", "grants", "credentialEnvironment", "autoStart", "settings"]) ||
      typeof raw.environment !== "string" ||
      raw.environment.length === 0 ||
      (raw.credentialEnvironment !== undefined &&
        (!Array.isArray(raw.credentialEnvironment) ||
          raw.credentialEnvironment.some((name) => typeof name !== "string"))) ||
      (raw.autoStart !== undefined && typeof raw.autoStart !== "boolean")
    )
      invalid();
    extension = {
      environment: raw.environment,
      ...(raw.grants === undefined ? {} : { grants: grants(raw.grants) }),
      ...(raw.credentialEnvironment === undefined
        ? {}
        : { credentialEnvironment: raw.credentialEnvironment as string[] }),
      ...(raw.autoStart === undefined ? {} : { autoStart: raw.autoStart as boolean }),
      ...(raw.settings === undefined ? {} : { settings: settings(raw.settings) }),
    };
  }
  return {
    source: value.source,
    package: packageName(value.package),
    version: version(value.version),
    ...(extension === undefined ? {} : { extension }),
  };
}

function updateParams(value: unknown): RegistryPackageUpdateRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["package", "version", "settings", "grants"])) invalid();
  return {
    package: packageName(value.package),
    version: version(value.version),
    ...(value.settings === undefined ? {} : { settings: settings(value.settings) }),
    ...(value.grants === undefined ? {} : { grants: grants(value.grants) }),
  };
}

function uninstallParams(value: unknown): RegistryPackageUninstallRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["package", "deleteData"]) ||
    (value.deleteData !== undefined && typeof value.deleteData !== "boolean")
  )
    invalid();
  return {
    package: packageName(value.package),
    ...(value.deleteData === undefined ? {} : { deleteData: value.deleteData as boolean }),
  };
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
