import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export interface Installation {
  id: string; title: string; version: string; server: string;
  configuration: Record<string, string>; environment: string; grants: string[];
  credentialEnvironment: string[]; autoStart: boolean;
  ui?: { name: string; entry: string; module: string; assets: string };
  mcp?: { description: string; commands: CommandDeclaration[] };
}

export interface CommandDeclaration {
  name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean;
}

export const extensionToolName = (id: string): string => `trust_extension_${id.replaceAll("-", "_")}`;

function readMcp(value: unknown): NonNullable<Installation["mcp"]> {
  const declaration = object(value);
  if (Object.keys(declaration).some(key => !["description", "commands"].includes(key)) || !Array.isArray(declaration.commands) || declaration.commands.length === 0) throw new Error("Invalid extension MCP declaration");
  const names = new Set<string>();
  const commands = declaration.commands.map(raw => {
    const command = object(raw);
    const name = string(command.name);
    const inputSchema = object(command.inputSchema);
    if (Object.keys(command).some(key => !["name", "description", "inputSchema", "readOnly"].includes(key)) || !/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(name) || names.has(name) || typeof command.readOnly !== "boolean" || inputSchema.type !== "object") throw new Error("Invalid extension command declaration");
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
  if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..")) throw new Error("Invalid extension path");
  const directory = await realpath(root);
  const target = await realpath(path.resolve(directory, relative));
  if (target !== directory && !target.startsWith(directory + path.sep)) throw new Error("Invalid extension path");
  return target;
}

export async function readInstallations(file: string | undefined): Promise<Installation[]> {
  if (file === undefined) return [];
  const document = object(JSON.parse(await readFile(file, "utf8")));
  if (!Array.isArray(document.extensions)) throw new Error("Invalid extension registry");
  const installations: Installation[] = [];
  for (const raw of document.extensions) {
    const item = object(raw);
    const manifestFile = string(item.manifest);
    if (!path.isAbsolute(manifestFile)) throw new Error("Extension manifest must be absolute");
    const manifest = object(JSON.parse(await readFile(manifestFile, "utf8")));
    const id = string(manifest.id);
    if (manifest.contract !== "trust.extension@1" || !/^[a-z][a-z0-9-]*$/.test(id) || installations.some(value => value.id === id)) throw new Error("Invalid extension identity");
    const requested = strings(manifest.requestedCapabilities);
    const grants = strings(item.grants);
    if ([...requested, ...grants].some(value => !["plans.read", "plans.subscribe"].includes(value)) || grants.some(value => !requested.includes(value))) throw new Error("Invalid extension grants");
    const configuration = object(item.configuration);
    const schema = object(manifest.configuration);
    if (Object.keys(configuration).some(key => !Object.hasOwn(schema, key))) throw new Error("Unknown extension configuration");
    for (const [key, rawField] of Object.entries(schema)) {
      const field = object(rawField);
      if (field.type !== "string" || Object.keys(field).some(key => !["type", "required"].includes(key)) || (field.required !== undefined && typeof field.required !== "boolean")) throw new Error("Invalid extension configuration declaration");
      if ((field.required || Object.hasOwn(configuration, key)) && typeof configuration[key] !== "string") throw new Error("Invalid extension configuration value");
    }
    const credentialEnvironment = strings(item.credentialEnvironment ?? []);
    if (credentialEnvironment.some(name => !/^[A-Z_][A-Z0-9_]*$/.test(name) || /^(NODE_|LD_|DYLD_)/.test(name))) throw new Error("Invalid extension credential environment");
    if (item.autoStart !== undefined && typeof item.autoStart !== "boolean") throw new Error("Invalid extension autoStart");
    const root = path.dirname(manifestFile);
    const installation: Installation = {
      id, title: string(manifest.title), version: string(manifest.version),
      server: await confinedPath(root, string(manifest.server)),
      configuration: configuration as Record<string, string>, environment: string(item.environment),
      grants, credentialEnvironment, autoStart: item.autoStart === true,
    };
    if (manifest.mcp !== undefined) installation.mcp = readMcp(manifest.mcp);
    if (manifest.ui !== undefined) {
      const ui = object(manifest.ui);
      const entry = string(ui.entry);
      if (path.isAbsolute(entry) || entry.includes("\\") || entry.split("/").some(part => part === ".." || part === "")) throw new Error("Invalid extension UI entry");
      installation.ui = { name: string(ui.name), module: string(ui.module), entry, assets: await confinedPath(root, string(ui.assets)) };
    }
    installations.push(installation);
  }
  return installations;
}
