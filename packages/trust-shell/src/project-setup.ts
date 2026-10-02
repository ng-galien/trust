import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse } from "smol-toml";

import type { TrustInstallation } from "./installation.js";
import { deployRunner } from "./runner-deployment.js";

export const SETUP_AGENTS = ["claude-code", "codex"] as const;
export type SetupAgent = (typeof SETUP_AGENTS)[number];

export interface TrustEndpoints {
  readonly mcp: string;
  readonly rpc: string;
  readonly otlp: string;
}

export interface ProjectSetupResult {
  readonly agent: SetupAgent;
  readonly skillsDirectory: string;
  readonly runnerDirectory: string;
  readonly mcpConfiguration: string;
  readonly endpointConfiguration: string;
}

interface ProjectSetupPlan extends ProjectSetupResult {
  readonly operationsSkill: string;
  readonly writes: readonly { readonly file: string; readonly content: string }[];
}

/** Public endpoints of a TRUST server reached through its web address. */
export function trustEndpoints(serverUrl: string): TrustEndpoints {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new TypeError(`Invalid TRUST server URL: ${serverUrl}`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new TypeError(`TRUST server URL must be a plain http(s) address: ${serverUrl}`);
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  return { mcp: `${base}/mcp`, rpc: `${base}/rpc`, otlp: `${base}/v1/traces` };
}

/**
 * Installs the TRUST skills and Runner in a project and points the selected agents at one server. Every
 * agent's configuration is validated and merged before any file is written, so a refusal changes nothing.
 * Only TRUST entries are written; every other file, key and table is kept as found.
 */
export async function setupProject(
  installation: TrustInstallation,
  projectDirectory: string,
  agents: readonly SetupAgent[],
  endpoints: TrustEndpoints,
): Promise<ProjectSetupResult[]> {
  const project = path.resolve(projectDirectory);
  if (!(await lstat(project).catch(() => undefined))?.isDirectory())
    throw new TypeError(`Project directory not found: ${project}`);
  const plans: ProjectSetupPlan[] = [];
  for (const agent of agents) plans.push(await planSetup(project, agent, endpoints));
  for (const plan of plans) {
    await mkdir(plan.skillsDirectory, { recursive: true });
    // Files added beside the skill, such as references/project.md, are kept.
    await cp(installation.operationsSkillSource, plan.operationsSkill, { recursive: true, force: true });
    await deployRunner(installation, plan.runnerDirectory);
    for (const { file, content } of plan.writes) {
      if ((await readOptional(file)) === content) continue;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
    }
  }
  return plans.map(({ agent, skillsDirectory, runnerDirectory, mcpConfiguration, endpointConfiguration }) => ({
    agent,
    skillsDirectory,
    runnerDirectory,
    mcpConfiguration,
    endpointConfiguration,
  }));
}

async function planSetup(project: string, agent: SetupAgent, endpoints: TrustEndpoints): Promise<ProjectSetupPlan> {
  const skillsDirectory = path.join(project, agent === "claude-code" ? ".claude/skills" : ".agents/skills");
  const operationsSkill = path.join(skillsDirectory, "trust-operations");
  const runnerDirectory = path.join(skillsDirectory, "trust");
  await refuseSymbolicLink(operationsSkill);
  await refuseSymbolicLink(runnerDirectory);
  if (agent === "claude-code") {
    const mcpConfiguration = path.join(project, ".mcp.json");
    const endpointConfiguration = path.join(project, ".claude/settings.json");
    return {
      agent,
      skillsDirectory,
      operationsSkill,
      runnerDirectory,
      mcpConfiguration,
      endpointConfiguration,
      writes: [
        {
          file: mcpConfiguration,
          content: mergeJson(mcpConfiguration, await readOptional(mcpConfiguration), (root) => {
            objectMember(root, "mcpServers", mcpConfiguration).trust = { type: "http", url: endpoints.mcp };
          }),
        },
        {
          file: endpointConfiguration,
          content: mergeJson(endpointConfiguration, await readOptional(endpointConfiguration), (root) => {
            const environment = objectMember(root, "env", endpointConfiguration);
            environment.TRUST_RPC_ENDPOINT = endpoints.rpc;
            environment.TRUST_OTLP_ENDPOINT = endpoints.otlp;
          }),
        },
      ],
    };
  }
  const configuration = path.join(project, ".codex/config.toml");
  return {
    agent,
    skillsDirectory,
    operationsSkill,
    runnerDirectory,
    mcpConfiguration: configuration,
    endpointConfiguration: configuration,
    writes: [
      {
        file: configuration,
        content: mergeCodexConfiguration(configuration, await readOptional(configuration), endpoints),
      },
    ],
  };
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function refuseSymbolicLink(target: string): Promise<void> {
  if ((await lstat(target).catch(() => undefined))?.isSymbolicLink())
    throw new TypeError(`Skill destination must not be a symbolic link: ${target}`);
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeJson(file: string, source: string | undefined, update: (root: JsonObject) => void): string {
  let root: unknown = {};
  if (source !== undefined && source.trim() !== "") {
    try {
      root = JSON.parse(source);
    } catch {
      throw new TypeError(`Refusing to change ${file}: it is not valid JSON`);
    }
  }
  if (!isJsonObject(root)) throw new TypeError(`Refusing to change ${file}: its root is not a JSON object`);
  update(root);
  return `${JSON.stringify(root, null, 2)}\n`;
}

function objectMember(root: JsonObject, key: string, file: string): JsonObject {
  const value = root[key] ?? {};
  if (!isJsonObject(value)) throw new TypeError(`Refusing to change ${file}: "${key}" is not a JSON object`);
  root[key] = value;
  return value;
}

type TomlValue = string | boolean;

interface TomlTableUpdate {
  readonly table: readonly string[];
  /** `replace` rewrites the table and its sub-tables; `merge` sets keys and keeps the others. */
  readonly mode: "replace" | "merge";
  readonly values: readonly (readonly [string, TomlValue])[];
}

const TOML_TABLE_HEADER = /^\s*\[(?!\[)([^\]]*)\]\s*(?:#.*)?$/;
const TOML_ARRAY_TABLE_HEADER = /^\s*\[\[([^\]]*)\]\]\s*(?:#.*)?$/;
const TOML_KEY_LINE =
  /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=/;

/**
 * Replaces the TRUST MCP server table and sets the Runner endpoint variables in a Codex configuration.
 * The edit keeps every other line verbatim; the result is then parsed and must equal the original
 * configuration with only those TRUST entries changed, otherwise the file is refused.
 */
function mergeCodexConfiguration(file: string, source: string | undefined, endpoints: TrustEndpoints): string {
  const refuse = (reason: string) => new TypeError(`Refusing to change ${file}: ${reason}`);
  const text = source ?? "";
  let expected: Record<string, unknown>;
  try {
    expected = parse(text);
  } catch (error) {
    throw refuse(`it is not valid TOML (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
  const servers = expected.mcp_servers ?? {};
  const policy = expected.shell_environment_policy ?? {};
  if (!isJsonObject(servers) || !isJsonObject(policy))
    throw refuse("mcp_servers or shell_environment_policy is not a table");
  const variables = policy.set ?? {};
  if (!isJsonObject(variables)) throw refuse("shell_environment_policy.set is not a table");
  servers.trust = { url: endpoints.mcp, enabled: true };
  variables.TRUST_RPC_ENDPOINT = endpoints.rpc;
  variables.TRUST_OTLP_ENDPOINT = endpoints.otlp;
  policy.set = variables;
  expected.mcp_servers = servers;
  expected.shell_environment_policy = policy;

  const result = editTomlTables(text, [
    {
      table: ["mcp_servers", "trust"],
      mode: "replace",
      values: [
        ["url", endpoints.mcp],
        ["enabled", true],
      ],
    },
    {
      table: ["shell_environment_policy", "set"],
      mode: "merge",
      values: [
        ["TRUST_RPC_ENDPOINT", endpoints.rpc],
        ["TRUST_OTLP_ENDPOINT", endpoints.otlp],
      ],
    },
  ]);
  let merged: unknown;
  try {
    merged = parse(result);
  } catch {
    merged = undefined;
  }
  if (!isDeepStrictEqual(plainData(merged), plainData(expected)))
    throw refuse("its TRUST tables use inline tables, dotted keys or multi-line values that cannot be edited in place");
  return result;
}

/** TOML tables have no prototype and dates are objects; both compare as plain JSON data. */
function plainData(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function editTomlTables(source: string, updates: readonly TomlTableUpdate[]): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source === "" ? [] : source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const update of updates) {
    const header = `[${update.table.map(tomlKey).join(".")}]`;
    const assignments = update.values.map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`);
    const sections = tomlSections(lines);
    if (update.mode === "replace") {
      const owned = sections.filter((section) => section.start > 0 && isPrefix(update.table, section.table));
      for (const section of [...owned].reverse()) {
        let end = section.end;
        while (end > section.start && lines[end - 1]?.trim() === "") end--;
        lines.splice(section.start - 1, end - section.start + 1);
      }
      const first = owned[0];
      if (first !== undefined) {
        lines.splice(first.start - 1, 0, header, ...assignments);
        const after = first.start + assignments.length;
        while (lines[after]?.trim() === "" && lines[after + 1]?.trim() === "") lines.splice(after, 1);
        continue;
      }
    } else {
      const section = sections.find((candidate) => candidate.start > 0 && sameKey(candidate.table, update.table));
      if (section !== undefined) {
        let end = section.end;
        for (const [index, [key]] of update.values.entries()) {
          const existing = section.keyLines.find((line) => sameKey(keyOf(lines[line] ?? "") ?? [], [key]));
          if (existing !== undefined) {
            lines[existing] = assignments[index] ?? "";
            continue;
          }
          let insertion = end;
          while (insertion > section.start && lines[insertion - 1]?.trim() === "") insertion--;
          lines.splice(insertion, 0, assignments[index] ?? "");
          end++;
        }
        continue;
      }
    }
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(header, ...assignments);
  }
  return lines.length === 0 ? "" : `${lines.join(newline)}${newline}`;
}

interface TomlSection {
  readonly table: readonly string[];
  readonly array: boolean;
  /** First body line. */
  readonly start: number;
  /** Line after the body. */
  readonly end: number;
  /** Body lines that begin a key/value pair, outside multi-line strings. */
  readonly keyLines: readonly number[];
}

function tomlSections(lines: readonly string[]): TomlSection[] {
  const sections: TomlSection[] = [];
  let current = { table: [] as readonly string[], array: false, start: 0, keyLines: [] as number[] };
  let multiline: string | undefined;
  lines.forEach((line, index) => {
    if (multiline !== undefined) {
      if (line.split(multiline).length % 2 === 0) multiline = undefined;
      return;
    }
    const array = TOML_ARRAY_TABLE_HEADER.exec(line);
    const table = array ? undefined : TOML_TABLE_HEADER.exec(line);
    if (array || table) {
      sections.push({ ...current, end: index });
      current = {
        table: splitKey(((array ?? table)?.[1] ?? "").trim()),
        array: array !== null,
        start: index + 1,
        keyLines: [],
      };
      return;
    }
    if (keyOf(line) !== undefined) current.keyLines.push(index);
    multiline = ['"""', "'''"].find((delimiter) => line.split(delimiter).length % 2 === 0);
  });
  sections.push({ ...current, end: lines.length });
  return sections;
}

function keyOf(line: string): string[] | undefined {
  const match = TOML_KEY_LINE.exec(line);
  return match?.[1] === undefined ? undefined : splitKey(match[1]);
}

function splitKey(value: string): string[] {
  const parts: string[] = [];
  const pattern = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.|$)/gy;
  for (let match = pattern.exec(value); match !== null && match[0] !== ""; match = pattern.exec(value)) {
    const raw = match[1] ?? "";
    parts.push(raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.startsWith("'") ? raw.slice(1, -1) : raw);
  }
  return parts;
}

function sameKey(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((part, index) => part === value[index]);
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value: TomlValue): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
