import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  EXTENSION_CAPABILITIES,
  type ExtensionCapability,
  type ExtensionSettingsSchema,
  type ExtensionSettingsValues,
  formatExtensionSettingsIssues,
  type Installation,
  parseExtensionSettingsSchema,
  validateExtensionSettings,
} from "@trust/extension-sdk";

export const extensionToolName = (id: string): string => `trust_extension_${id.replaceAll("-", "_")}`;

function readMcp(value: unknown): NonNullable<Installation["mcp"]> {
  const declaration = object(value);
  if (
    Object.keys(declaration).some((key) => !["description", "commands"].includes(key)) ||
    !Array.isArray(declaration.commands) ||
    declaration.commands.length === 0
  )
    throw new Error("Invalid extension MCP declaration");
  const names = new Set<string>();
  const commands = declaration.commands.map((raw) => {
    const command = object(raw);
    const name = string(command.name);
    const inputSchema = object(command.inputSchema);
    if (
      Object.keys(command).some((key) => !["name", "description", "inputSchema", "readOnly"].includes(key)) ||
      !/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(name) ||
      names.has(name) ||
      typeof command.readOnly !== "boolean" ||
      inputSchema.type !== "object"
    )
      throw new Error("Invalid extension command declaration");
    names.add(name);
    return { name, description: string(command.description), inputSchema, readOnly: command.readOnly };
  });
  return { description: string(declaration.description), commands };
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid extension installation");
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid extension field");
  return value;
};
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error("Invalid extension list");
  return value.map(string);
};

export async function confinedPath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes(".."))
    throw new Error("Invalid extension path");
  const directory = await realpath(root);
  const target = await realpath(path.resolve(directory, relative));
  if (target !== directory && !target.startsWith(directory + path.sep)) throw new Error("Invalid extension path");
  return target;
}

export interface ExtensionManifest {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly manifest: string;
  readonly server: string;
  readonly requestedCapabilities: ExtensionCapability[];
  readonly settingsSchema: ExtensionSettingsSchema;
  readonly mcp?: Installation["mcp"];
  readonly ui?: Installation["ui"];
}

export interface InstallationValues {
  readonly environment: string;
  readonly grants: readonly string[];
  readonly credentialEnvironment: readonly string[];
  readonly autoStart: boolean;
  readonly settings: ExtensionSettingsValues;
}

/** Read one installed `extension.json`; paths stay confined to its directory. */
export async function readManifest(manifestFile: string): Promise<ExtensionManifest> {
  if (!path.isAbsolute(manifestFile)) throw new Error("Extension manifest must be absolute");
  const manifest = object(JSON.parse(await readFile(manifestFile, "utf8")));
  const id = string(manifest.id);
  if (manifest.contract !== "trust.extension@1" || !/^[a-z][a-z0-9-]*$/.test(id))
    throw new Error("Invalid extension identity");
  const requestedCapabilities = capabilities(manifest.requestedCapabilities);
  if (manifest.settings !== undefined && manifest.configuration !== undefined)
    throw new Error("Extension manifest declares both settings and configuration");
  const settingsSchema =
    manifest.settings !== undefined
      ? parseExtensionSettingsSchema(manifest.settings)
      : declaredConfigurationSchema(manifest.configuration);
  const root = path.dirname(manifestFile);
  const result: {
    -readonly [K in keyof ExtensionManifest]: ExtensionManifest[K];
  } = {
    id,
    title: string(manifest.title),
    version: string(manifest.version),
    manifest: manifestFile,
    server: await confinedPath(root, string(manifest.server)),
    requestedCapabilities,
    settingsSchema,
  };
  if (manifest.mcp !== undefined) result.mcp = readMcp(manifest.mcp);
  if (manifest.ui !== undefined) {
    const ui = object(manifest.ui);
    const entry = string(ui.entry);
    if (path.isAbsolute(entry) || entry.includes("\\") || entry.split("/").some((part) => part === ".." || part === ""))
      throw new Error("Invalid extension UI entry");
    result.ui = {
      name: string(ui.name),
      module: string(ui.module),
      entry,
      assets: await confinedPath(root, string(ui.assets)),
    };
  }
  return result;
}

/** The flat string-field `configuration` declaration of manifests not yet declaring a settings schema. */
function declaredConfigurationSchema(value: unknown): ExtensionSettingsSchema {
  const declaration = object(value ?? {});
  const properties: Record<string, { type: "string" }> = {};
  const required: string[] = [];
  for (const [key, rawField] of Object.entries(declaration)) {
    const field = object(rawField);
    if (
      field.type !== "string" ||
      Object.keys(field).some((name) => !["type", "required"].includes(name)) ||
      (field.required !== undefined && typeof field.required !== "boolean")
    )
      throw new Error("Invalid extension configuration declaration");
    properties[key] = { type: "string" };
    if (field.required) required.push(key);
  }
  return parseExtensionSettingsSchema({
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  });
}

/** Combine one manifest with installation values; callers validate settings at their own boundary. */
export function installationOf(manifest: ExtensionManifest, values: InstallationValues): Installation {
  const grants = capabilities(values.grants);
  if (grants.some((value) => !manifest.requestedCapabilities.includes(value)))
    throw new Error("Invalid extension grants");
  const credentialEnvironment = strings(values.credentialEnvironment);
  if (credentialEnvironment.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name) || /^(NODE_|LD_|DYLD_)/.test(name)))
    throw new Error("Invalid extension credential environment");
  const installation: Installation = {
    id: manifest.id,
    title: manifest.title,
    version: manifest.version,
    server: manifest.server,
    manifest: manifest.manifest,
    requestedCapabilities: manifest.requestedCapabilities,
    settingsSchema: manifest.settingsSchema,
    settings: values.settings,
    environment: string(values.environment),
    grants,
    credentialEnvironment,
    autoStart: values.autoStart,
  };
  if (manifest.mcp) installation.mcp = manifest.mcp;
  if (manifest.ui) installation.ui = manifest.ui;
  return installation;
}

/** Installations declared by the operator installation file, with their initial settings values. */
export async function readInstallations(file: string | undefined): Promise<Installation[]> {
  if (file === undefined) return [];
  const document = object(JSON.parse(await readFile(file, "utf8")));
  if (!Array.isArray(document.extensions)) throw new Error("Invalid extension registry");
  const installations: Installation[] = [];
  for (const raw of document.extensions) {
    const item = object(raw);
    const manifest = await readManifest(string(item.manifest));
    if (installations.some((value) => value.id === manifest.id)) throw new Error("Invalid extension identity");
    if (item.autoStart !== undefined && typeof item.autoStart !== "boolean")
      throw new Error("Invalid extension autoStart");
    installations.push(
      installationOf(manifest, {
        environment: string(item.environment),
        grants: strings(item.grants),
        credentialEnvironment: strings(item.credentialEnvironment ?? []),
        autoStart: item.autoStart === true,
        settings: declaredSettings(manifest, item.configuration ?? {}),
      }),
    );
  }
  return installations;
}

function declaredSettings(manifest: ExtensionManifest, value: unknown): ExtensionSettingsValues {
  const validation = validateExtensionSettings(manifest.settingsSchema, value);
  if (!validation.valid) throw new Error(`${manifest.id}: ${formatExtensionSettingsIssues(validation.issues)}`);
  return validation.values;
}

function capabilities(value: unknown): ExtensionCapability[] {
  const list = strings(value);
  if (list.some((item) => !(EXTENSION_CAPABILITIES as readonly string[]).includes(item)))
    throw new Error("Invalid extension grants");
  return list as ExtensionCapability[];
}
