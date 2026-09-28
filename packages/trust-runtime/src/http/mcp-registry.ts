import { EXTENSION_CAPABILITIES } from "@trust/extension-sdk";

import { RegistryError, registryFailure } from "../registry/error.js";
import {
  executeRegistryRpc,
  InvalidRegistryRpcParams,
  REGISTRY_RPC_METHODS,
  type RegistryRpcDependencies,
  type RegistryRpcMethod,
} from "./registry.js";

type RegistryToolName = `trust_${string}`;

const toolName = (method: RegistryRpcMethod): RegistryToolName => `trust_${method.replaceAll(".", "_")}`;
const methodOf = new Map(REGISTRY_RPC_METHODS.map((method) => [toolName(method), method]));

export function isRegistryToolName(value: unknown): value is RegistryToolName {
  return typeof value === "string" && methodOf.has(value as RegistryToolName);
}

const name = { type: "string", description: "Registry source name" };
const packageName = { type: "string", pattern: "^[a-z][a-z0-9-]*$", description: "Package name" };
const version = { type: "string", description: "Exact package version offered by the last refreshed index" };
const settings = { type: "object", description: "Extension settings values validated by the extension schema" };
const grants = { type: "array", items: { enum: [...EXTENSION_CAPABILITIES] } };
const closed = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const DEFINITIONS: Readonly<
  Record<RegistryRpcMethod, { title: string; description: string; readOnly: boolean; inputSchema: unknown }>
> = {
  "registry.source.list": {
    title: "List registry sources",
    description: "List configured Git, HTTP and local file registry sources.",
    readOnly: true,
    inputSchema: closed({}),
  },
  "registry.source.save": {
    title: "Save a registry source",
    description:
      "Create or update a named source: a Git repository (index trust-registry.json at its root, optional reference), an HTTP(S) index URL or the absolute path of a local index file. Nothing is read or installed.",
    readOnly: false,
    inputSchema: closed(
      {
        name,
        kind: { enum: ["git", "http", "file"] },
        url: { type: "string" },
        reference: { type: "string", description: "Git branch or tag" },
      },
      ["name", "kind", "url"],
    ),
  },
  "registry.source.remove": {
    title: "Remove a registry source",
    description: "Remove a source and its refreshed index. Packages installed from it stay installed and are listed.",
    readOnly: false,
    inputSchema: closed({ name }, ["name"]),
  },
  "registry.source.sync": {
    title: "Synchronize a registry source",
    description: "Import the Operations and Procedures of a trust.registry-index@1 source.",
    readOnly: false,
    inputSchema: closed({ name }, ["name"]),
  },
  "registry.source.refresh": {
    title: "Refresh a registry index",
    description:
      "Explicitly read the source's trust.registry-index@2 and record the available packages and revision. Never installs or updates a package.",
    readOnly: false,
    inputSchema: closed({ name }, ["name"]),
  },
  "registry.source.read": {
    title: "Read a registry index",
    description:
      "Read the last refreshed index of one source: packages, versions, content categories, located contents and installed versions. Never contacts the source.",
    readOnly: true,
    inputSchema: closed({ name }, ["name"]),
  },
  "registry.package.list": {
    title: "List installed packages",
    description: "List installed packages with their installed version and the versions available in their source.",
    readOnly: true,
    inputSchema: closed({}),
  },
  "registry.package.install": {
    title: "Install a registry package",
    description:
      "Acquire the pinned revision, verify every digest and identity, build extension code only, place the package under its package and version directory, import Operations then Procedures and register the extension stopped. A failure installs nothing.",
    readOnly: false,
    inputSchema: closed(
      {
        source: name,
        package: packageName,
        version,
        extension: closed(
          {
            environment: { type: "string" },
            grants,
            credentialEnvironment: { type: "array", items: { type: "string" } },
            autoStart: { type: "boolean" },
            settings,
          },
          ["environment"],
        ),
      },
      ["source", "package", "version"],
    ),
  },
  "registry.package.update": {
    title: "Update a registry package",
    description:
      "Explicitly update an installed package to an identified version of its source. Existing Plans keep their pinned versions; on failure the previous version stays installed and running.",
    readOnly: false,
    inputSchema: closed({ package: packageName, version, settings, grants }, ["package", "version"]),
  },
  "registry.package.uninstall": {
    title: "Uninstall a registry package",
    description:
      "Remove the package files and extension installation and report removed and kept items. Published Operations, Procedures, Plans and the source are kept; extension data is deleted only with deleteData.",
    readOnly: false,
    inputSchema: closed({ package: packageName, deleteData: { type: "boolean" } }, ["package"]),
  },
};

export function registryTools() {
  return REGISTRY_RPC_METHODS.map((method) => ({
    name: toolName(method),
    title: DEFINITIONS[method].title,
    description: DEFINITIONS[method].description,
    annotations: { readOnlyHint: DEFINITIONS[method].readOnly },
    inputSchema: DEFINITIONS[method].inputSchema,
  }));
}

/** Calls the same runtime functions as the RPC surface; refusals carry the public registry error body. */
export async function callRegistryTool(
  tool: RegistryToolName,
  argumentsValue: Record<string, unknown>,
  dependencies: RegistryRpcDependencies,
): Promise<{ isError: boolean; text: string }> {
  const method = methodOf.get(tool);
  if (method === undefined) return { isError: true, text: "Unknown registry tool." };
  try {
    const result = await executeRegistryRpc(method, argumentsValue, dependencies);
    return { isError: false, text: JSON.stringify(result) };
  } catch (error) {
    if (error instanceof InvalidRegistryRpcParams)
      return { isError: true, text: "Registry tool arguments are invalid." };
    if (error instanceof RegistryError) return { isError: true, text: JSON.stringify(registryFailure(error)) };
    throw error;
  }
}
