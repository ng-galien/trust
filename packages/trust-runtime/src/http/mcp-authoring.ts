import type {
  CatalogMetadata,
  CatalogMetadataUpdate,
  PublishedProcedure,
  RuntimeJsonObject,
  TrialRecord,
  TrialSummary,
} from "@trust/extension-sdk";
import {
  type CompiledOperation,
  compileOperation,
  OperationCompilationError,
  OperationValidationError,
  operationCredentialNames,
  simulateOperation,
} from "@trust/operation";
import { CatalogProcedureCompilationError, type CompiledProcedure } from "@trust/procedure";
import {
  type CatalogClassification,
  type CatalogKind,
  CatalogMetadataError,
  type CatalogMetadataStore,
  matchesCatalogQuery,
} from "../catalog/metadata.js";
import type { EnvironmentService } from "../environment/service.js";
import { EnvironmentConfigurationError } from "../environment/validation.js";
import { type OperationCatalog, OperationCatalogError } from "../operation/catalog.js";
import type { Procedures } from "../procedure/procedures.js";
import { ProcedureConflictError } from "../procedure/store.js";
import { TemplateError, type TemplateService } from "../template/service.js";
import { TrialError, type TrialService } from "../trial/service.js";
import { templateTools } from "./mcp-templates.js";

export const AUTHORING_TOOL_NAMES = [
  "trust_template_list",
  "trust_template_read",
  "trust_template_save",
  "trust_template_remove",
  "trust_template_render",
  "trust_environment_list",
  "trust_environment_save",
  "trust_environment_remove",
  "trust_operation_list",
  "trust_operation_read",
  "trust_operation_compile",
  "trust_operation_save",
  "trust_operation_remove",
  "trust_operation_simulate",
  "trust_operation_environment_list",
  "trust_operation_trial_start",
  "trust_operation_trial_list",
  "trust_operation_trial_read",
  "trust_operation_trial_cancel",
  "trust_procedure_list",
  "trust_published_procedure_read",
  "trust_procedure_compile",
  "trust_procedure_publish",
  "trust_catalog_metadata_update",
] as const;

export type AuthoringToolName = (typeof AUTHORING_TOOL_NAMES)[number];

export interface McpAuthoringDependencies {
  readonly catalogMetadata: CatalogMetadataStore;
  readonly environmentService: EnvironmentService;
  readonly operationCatalog: OperationCatalog;
  readonly procedures: Procedures;
  readonly templateService: TemplateService;
  readonly trialService: TrialService;
}

export interface McpAuthoringResult {
  readonly text: string;
  readonly isError?: true;
}

export class InvalidMcpAuthoringArguments extends Error {
  constructor(readonly tool: AuthoringToolName) {
    super(`${tool} arguments are invalid`);
    this.name = "InvalidMcpAuthoringArguments";
  }
}

export function isAuthoringToolName(value: unknown): value is AuthoringToolName {
  return typeof value === "string" && (AUTHORING_TOOL_NAMES as readonly string[]).includes(value);
}

export async function callAuthoringTool(
  tool: AuthoringToolName,
  args: Record<string, unknown>,
  dependencies: McpAuthoringDependencies,
): Promise<McpAuthoringResult> {
  try {
    switch (tool) {
      case "trust_template_list":
        return { text: json(await dependencies.templateService.list(args)) };
      case "trust_template_read":
        return { text: json(await dependencies.templateService.read(args)) };
      case "trust_template_save":
        return { text: json(await dependencies.templateService.save(args)) };
      case "trust_template_remove":
        return { text: json(await dependencies.templateService.remove(args)) };
      case "trust_template_render":
        return { text: json(await dependencies.templateService.render(args)) };
      case "trust_environment_list": {
        exactEmpty(args, tool);
        const environments = dependencies.environmentService.list();
        return {
          text: [
            "ENVIRONMENTS",
            `Count: ${environments.length}`,
            ...environments.map(
              (environment) => `Environment: ${environment.name}\nValues:\n${json(environment.values)}`,
            ),
            "",
          ].join("\n"),
        };
      }
      case "trust_environment_save": {
        if (
          !hasOnlyKeys(args, ["environment", "values"]) ||
          !bounded(args.environment, 63) ||
          !isRecord(args.values) ||
          !Object.values(args.values).every((value) => typeof value === "string")
        )
          invalid(tool);
        const environment = await dependencies.environmentService.save(
          args.environment,
          args.values as Record<string, string>,
        );
        return { text: `ENVIRONMENT SAVED\nEnvironment: ${environment.name}\nValues:\n${json(environment.values)}\n` };
      }
      case "trust_environment_remove": {
        if (!hasOnlyKeys(args, ["environment"]) || !bounded(args.environment, 63)) invalid(tool);
        const removed = await dependencies.environmentService.remove(args.environment, true);
        return { text: `ENVIRONMENT REMOVAL\nEnvironment: ${args.environment}\nRemoved: ${removed ? "yes" : "no"}\n` };
      }
      case "trust_operation_list": {
        const query = exactCatalogQuery(args, tool);
        return { text: await renderOperationList(dependencies.operationCatalog, dependencies.catalogMetadata, query) };
      }
      case "trust_operation_read": {
        const { operation, version } = exactIdentity(args, "operation", tool);
        const entry = dependencies.operationCatalog.entry(operation, version);
        return entry === undefined
          ? rejected(`Operation ${operation}@${version} is not in the catalog.`)
          : {
              text: renderOperation(
                "OPERATION",
                entry.operation,
                entry.sourceName,
                await dependencies.catalogMetadata.read("operation", operation, version),
              ),
            };
      }
      case "trust_operation_compile": {
        const input = exactSource(args, tool, false);
        return { text: renderOperation("OPERATION COMPILED", compileOperation(input), input.sourceName) };
      }
      case "trust_operation_save": {
        const input = exactSource(args, tool, true);
        const operation = await dependencies.operationCatalog.save(input.source, input.sourceName!);
        return { text: renderOperation("OPERATION SAVED", operation, input.sourceName) };
      }
      case "trust_operation_remove": {
        const { operation, version } = exactIdentity(args, "operation", tool);
        await dependencies.operationCatalog.remove(operation, version);
        return { text: `OPERATION REMOVED\nOperation: ${operation}@${version}\n` };
      }
      case "trust_operation_simulate": {
        const input = exactSimulation(args, tool);
        const result = await simulateOperation(input);
        return {
          text: [
            "OPERATION SIMULATED",
            `Operation: ${result.operation.operation}@${result.operation.version}`,
            "Produced:",
            json(result.produced),
            "",
          ].join("\n"),
        };
      }
      case "trust_operation_environment_list": {
        const scope = exactEnvironmentScope(args, tool);
        const environments = dependencies.trialService.environmentsFor(scope);
        return {
          text: [
            "OPERATION ENVIRONMENTS",
            `Count: ${environments.length}`,
            ...environments.map((environment) =>
              [
                `- ${environment.name}: ${environment.compatible ? "compatible" : "incompatible"}`,
                `  Declared values: ${Object.keys(environment.values).sort().join(", ") || "none"}`,
                ...(environment.missing.length === 0 ? [] : [`  Missing: ${environment.missing.join(", ")}`]),
              ].join("\n"),
            ),
            "",
          ].join("\n"),
        };
      }
      case "trust_operation_trial_start": {
        const input = exactTrialStart(args, tool);
        const trial = dependencies.trialService.start({ ...input, startedBy: "mcp-agent" });
        return { text: renderTrialSummary("OPERATION TRIAL STARTED", trial) };
      }
      case "trust_operation_trial_list": {
        const operation = exactOptionalOperation(args, tool);
        const trials = dependencies.trialService.list(operation);
        return {
          text: [
            "OPERATION TRIALS",
            `Count: ${trials.length}`,
            ...trials.map((trial) => renderTrialSummary("", trial).trim()),
            "",
          ].join("\n"),
        };
      }
      case "trust_operation_trial_read": {
        const { trial, after } = exactTrialRead(args, tool);
        return { text: renderTrial(dependencies.trialService.read(trial), after) };
      }
      case "trust_operation_trial_cancel": {
        const trial = exactTrialId(args, tool);
        return { text: renderTrialSummary("OPERATION TRIAL CANCELLED", dependencies.trialService.cancel(trial)) };
      }
      case "trust_procedure_list": {
        const query = exactCatalogQuery(args, tool);
        return {
          text: await renderProcedureList(await dependencies.procedures.list(), dependencies.catalogMetadata, query),
        };
      }
      case "trust_published_procedure_read": {
        const { operation: procedure, version } = exactIdentity(args, "procedure", tool);
        const published = await dependencies.procedures.find(procedure, version);
        return published === undefined
          ? rejected(`Procedure ${procedure}@${version} is not published.`)
          : {
              text: renderProcedure(
                "PUBLISHED PROCEDURE",
                published.procedure,
                published,
                await dependencies.catalogMetadata.read("procedure", procedure, version),
              ),
            };
      }
      case "trust_procedure_compile": {
        const input = exactSource(args, tool, false);
        return { text: renderProcedure("PROCEDURE COMPILED", await dependencies.procedures.compile(input)) };
      }
      case "trust_procedure_publish": {
        const input = exactSource(args, tool, false);
        const published = await dependencies.procedures.publish(input, "mcp-agent");
        return { text: renderProcedure("PROCEDURE PUBLISHED", published.procedure, published) };
      }
      case "trust_catalog_metadata_update": {
        const input = exactCatalogMetadataUpdate(args, tool);
        const metadata = await dependencies.catalogMetadata.update(input);
        return { text: renderCatalogMetadata("CATALOG METADATA UPDATED", metadata) };
      }
    }
  } catch (error) {
    if (error instanceof TemplateError) return rejected(error.message);
    if (error instanceof InvalidMcpAuthoringArguments) throw error;
    if (
      error instanceof CatalogProcedureCompilationError ||
      error instanceof OperationCompilationError ||
      error instanceof OperationValidationError ||
      error instanceof OperationCatalogError ||
      error instanceof ProcedureConflictError ||
      error instanceof TrialError ||
      error instanceof EnvironmentConfigurationError ||
      error instanceof CatalogMetadataError ||
      error instanceof TypeError
    ) {
      return rejected(renderAuthoringError(tool, error));
    }
    throw error;
  }
}

function rejected(text: string): McpAuthoringResult {
  return { text, isError: true };
}

function renderAuthoringError(tool: AuthoringToolName, error: Error): string {
  const location =
    "location" in error && isRecord(error.location) && typeof error.location.line === "number"
      ? `\nLocation: ${error.location.line}:${typeof error.location.column === "number" ? error.location.column : 1}`
      : "";
  const reason =
    "code" in error && typeof error.code === "string"
      ? error.code
      : "reason" in error && typeof error.reason === "string"
        ? error.reason
        : undefined;
  return `${tool} rejected the request.${reason ? `\nReason: ${reason}` : ""}\nMessage: ${error.message}${location}`;
}

async function renderOperationList(
  catalog: OperationCatalog,
  metadataStore: CatalogMetadataStore,
  query?: string,
): Promise<string> {
  const entries = catalog.list();
  const results = await Promise.all(
    entries.map(async (operation) => ({
      operation,
      metadata: await metadataStore.read("operation", operation.operation, operation.version),
    })),
  );
  const matching = results.filter(
    (entry): entry is { operation: CompiledOperation; metadata: CatalogMetadata } =>
      entry.metadata !== undefined && (query === undefined || matchesCatalogQuery(entry.metadata, query)),
  );
  return [
    "OPERATION CATALOG",
    ...(query === undefined ? [] : [`Query: ${query}`]),
    `Count: ${matching.length}`,
    ...matching.map(({ operation, metadata }) => {
      const sourceName = catalog.entry(operation.operation, operation.version)?.sourceName;
      return [
        `- ${operation.operation}@${operation.version}: ${metadata.title}${sourceName ? ` [${sourceName}]` : ""}`,
        ...(metadata.description ? [`  Description: ${metadata.description}`] : []),
        `  Tags: ${formatClassification(metadata.classification)}`,
        `  Metadata revision: ${metadata.revision}`,
      ].join("\n");
    }),
    "",
  ].join("\n");
}

function renderOperation(
  heading: string,
  operation: CompiledOperation,
  sourceName?: string,
  metadata?: CatalogMetadata,
): string {
  return [
    heading,
    `Operation: ${operation.operation}@${operation.version}`,
    `Title: ${metadata?.title ?? operation.title}`,
    ...((metadata === undefined ? operation.description : metadata.description)
      ? [`Description: ${metadata === undefined ? operation.description : metadata.description}`]
      : []),
    ...(metadata
      ? [`Tags: ${formatClassification(metadata.classification)}`, `Metadata revision: ${metadata.revision}`]
      : []),
    ...(sourceName ? [`Source name: ${sourceName}`] : []),
    `Input fields: ${Object.keys(operation.input.properties).join(", ") || "none"}`,
    `Environment fields: ${Object.keys(operation.environment.properties).join(", ") || "none"}`,
    `Credentials: ${operationCredentialNames(operation).join(", ") || "none"}`,
    `Steps: ${operation.steps.map((step) => `${step.name} (${step.type})`).join(", ") || "none"}`,
    `Produced fields: ${Object.keys(operation.produced.properties).join(", ") || "none"}`,
    "",
    "SOURCE",
    operation.source,
    "",
  ].join("\n");
}

async function renderProcedureList(
  procedures: readonly PublishedProcedure[],
  metadataStore: CatalogMetadataStore,
  query?: string,
): Promise<string> {
  const results = await Promise.all(
    procedures.map(async (published) => ({
      published,
      metadata: await metadataStore.read("procedure", published.procedure.procedure, published.procedure.version),
    })),
  );
  const matching = results.filter(
    (entry): entry is { published: PublishedProcedure; metadata: CatalogMetadata } =>
      entry.metadata !== undefined && (query === undefined || matchesCatalogQuery(entry.metadata, query)),
  );
  return [
    "PROCEDURE CATALOG",
    ...(query === undefined ? [] : [`Query: ${query}`]),
    `Count: ${matching.length}`,
    ...matching.map(({ published: { procedure, sourceName }, metadata }) =>
      [
        `- ${procedure.procedure}@${procedure.version}: ${metadata.title} [${sourceName}]`,
        ...(metadata.description ? [`  Description: ${metadata.description}`] : []),
        `  Tags: ${formatClassification(metadata.classification)}`,
        `  Metadata revision: ${metadata.revision}`,
      ].join("\n"),
    ),
    "",
  ].join("\n");
}

function renderProcedure(
  heading: string,
  procedure: CompiledProcedure,
  published?: PublishedProcedure,
  metadata?: CatalogMetadata,
): string {
  return [
    heading,
    `Procedure: ${procedure.procedure}@${procedure.version}`,
    `Title: ${metadata?.title ?? procedure.title}`,
    ...((metadata === undefined ? procedure.description : metadata.description)
      ? [`Description: ${metadata === undefined ? procedure.description : metadata.description}`]
      : []),
    ...(metadata
      ? [`Tags: ${formatClassification(metadata.classification)}`, `Metadata revision: ${metadata.revision}`]
      : []),
    `Definition digest: ${procedure.definitionDigest}`,
    `Intent chaining: ${procedure.intentChaining ? "enabled" : "disabled"}`,
    `Operations: ${procedure.operations.map((operation) => `${operation.operation}@${operation.version}`).join(", ") || "none"}`,
    `Roles: ${procedure.roles.map((role) => role.name).join(", ") || "none"}`,
    "Scenarios:",
    ...procedure.scenarios.map(
      (scenario) =>
        `- ${scenario.slug}: ${scenario.title}; after ${scenario.dependencies.join(", ") || "nothing"}; ${scenario.checks.length} Check(s)`,
    ),
    ...(published
      ? [
          `Source name: ${published.sourceName}`,
          `Published by: ${published.publishedBy}`,
          `Published at: ${published.publishedAt}`,
        ]
      : []),
    "",
    "SOURCE",
    procedure.source,
    "",
  ].join("\n");
}

function renderCatalogMetadata(heading: string, metadata: CatalogMetadata): string {
  return [
    heading,
    `Entry: ${metadata.kind} ${metadata.name}@${metadata.version}`,
    `Title: ${metadata.title}`,
    ...(metadata.description ? [`Description: ${metadata.description}`] : []),
    `Tags: ${formatClassification(metadata.classification)}`,
    `Metadata revision: ${metadata.revision}`,
    ...(metadata.updatedAt ? [`Updated at: ${metadata.updatedAt}`] : []),
    "",
  ].join("\n");
}

function formatClassification(classification: CatalogClassification): string {
  const tags = Object.entries(classification).flatMap(([key, values]) => values.map((value) => `${key}:${value}`));
  return tags.join(", ") || "none";
}

function renderTrialSummary(heading: string, trial: TrialSummary): string {
  return [
    ...(heading ? [heading] : []),
    `Trial: ${trial.id}`,
    `Operation: ${trial.operation}@${trial.version}`,
    `Environment: ${trial.environment}`,
    `Status: ${trial.status}`,
    `Started by: ${trial.startedBy}`,
    `Started at: ${trial.startedAt}`,
    ...(trial.endedAt ? [`Ended at: ${trial.endedAt}`] : []),
    ...(trial.error ? [`Error: ${trial.error}`] : []),
    `Events: ${trial.eventCount}`,
    "",
  ].join("\n");
}

function renderTrial(trial: TrialRecord, after: number): string {
  const events = trial.events.filter((event) => event.sequence > after);
  return [
    "OPERATION TRIAL",
    `Trial: ${trial.id}`,
    `Operation: ${trial.operation}@${trial.version}`,
    `Environment: ${trial.environment}`,
    `Status: ${trial.status}`,
    `Started by: ${trial.startedBy}`,
    `Started at: ${trial.startedAt}`,
    ...(trial.endedAt ? [`Ended at: ${trial.endedAt}`] : []),
    ...(trial.error ? [`Error: ${trial.error}`] : []),
    ...(trial.outcome === undefined ? [] : ["Outcome:", json(trial.outcome)]),
    "",
    `EVENTS AFTER ${after}`,
    ...(events.length === 0
      ? ["none"]
      : events.map((event) => `${event.sequence}. ${event.type} at ${event.at}\n${json(event)}`)),
    ...(events.length === 0 ? [] : [`Next event cursor: ${events.at(-1)!.sequence}`]),
    "",
  ].join("\n");
}

function exactEmpty(args: Record<string, unknown>, tool: AuthoringToolName): void {
  if (Object.keys(args).length !== 0) invalid(tool);
}

function exactCatalogQuery(args: Record<string, unknown>, tool: AuthoringToolName): string | undefined {
  if (!hasOnlyKeys(args, ["query"]) || (args.query !== undefined && !bounded(args.query, 200))) invalid(tool);
  return args.query as string | undefined;
}

function exactCatalogMetadataUpdate(args: Record<string, unknown>, tool: AuthoringToolName): CatalogMetadataUpdate {
  if (
    !hasOnlyKeys(args, ["kind", "name", "version", "expectedRevision", "title", "description", "classification"]) ||
    (args.kind !== "operation" && args.kind !== "procedure") ||
    !bounded(args.name, 256) ||
    !bounded(args.version, 64) ||
    !Number.isSafeInteger(args.expectedRevision) ||
    Number(args.expectedRevision) < 0 ||
    !bounded(args.title, 200) ||
    !String(args.title).trim() ||
    (args.description !== undefined && (typeof args.description !== "string" || args.description.length > 10_000)) ||
    !isRecord(args.classification) ||
    !Object.values(args.classification).every(
      (values) => Array.isArray(values) && values.every((value) => typeof value === "string"),
    )
  )
    invalid(tool);
  return {
    kind: args.kind as CatalogKind,
    name: args.name as string,
    version: args.version as string,
    expectedRevision: args.expectedRevision as number,
    title: args.title as string,
    ...(typeof args.description === "string" ? { description: args.description } : {}),
    classification: args.classification as CatalogClassification,
  };
}

function exactIdentity(
  args: Record<string, unknown>,
  name: "operation" | "procedure",
  tool: AuthoringToolName,
): { operation: string; version: string } {
  if (!hasOnlyKeys(args, [name, "version"]) || !bounded(args[name], 256) || !bounded(args.version, 64)) invalid(tool);
  return { operation: args[name] as string, version: args.version as string };
}

function exactSource(
  args: Record<string, unknown>,
  tool: AuthoringToolName,
  sourceNameRequired: boolean,
): { source: string; sourceName?: string } {
  if (!hasOnlyKeys(args, ["source", "sourceName"]) || !bounded(args.source, 1_000_000)) invalid(tool);
  if (sourceNameRequired && !bounded(args.sourceName, 255)) invalid(tool);
  if (args.sourceName !== undefined && !bounded(args.sourceName, 255)) invalid(tool);
  return {
    source: args.source as string,
    ...(typeof args.sourceName === "string" ? { sourceName: args.sourceName } : {}),
  };
}

function exactSimulation(args: Record<string, unknown>, tool: AuthoringToolName) {
  if (
    !hasOnlyKeys(args, ["source", "sourceName", "input", "environment", "steps"]) ||
    !bounded(args.source, 1_000_000) ||
    (args.sourceName !== undefined && !bounded(args.sourceName, 255)) ||
    !isRecord(args.input) ||
    !isRecord(args.environment) ||
    !isRecord(args.steps)
  )
    invalid(tool);
  return {
    source: args.source as string,
    ...(typeof args.sourceName === "string" ? { sourceName: args.sourceName } : {}),
    input: args.input,
    environment: args.environment,
    steps: args.steps,
  };
}

function exactEnvironmentScope(
  args: Record<string, unknown>,
  tool: AuthoringToolName,
): { operation?: string; version?: string; source?: string } {
  const hasSource = bounded(args.source, 1_000_000);
  const hasOperation = bounded(args.operation, 256);
  if (hasSource === hasOperation) invalid(tool);
  if (hasSource) {
    if (!hasOnlyKeys(args, ["source"])) invalid(tool);
    return { source: args.source as string };
  }
  if (!hasOnlyKeys(args, ["operation", "version"]) || !bounded(args.version, 64)) invalid(tool);
  return { operation: args.operation as string, version: args.version as string };
}

function exactTrialStart(
  args: Record<string, unknown>,
  tool: AuthoringToolName,
): { operation?: string; version?: string; source?: string; environment: string; input: RuntimeJsonObject } {
  const hasSource = bounded(args.source, 1_000_000);
  const hasOperation = bounded(args.operation, 256);
  if (
    hasSource === hasOperation ||
    !bounded(args.environment, 256) ||
    !isRecord(args.input) ||
    (hasOperation && !bounded(args.version, 64))
  )
    invalid(tool);
  const allowed = hasSource ? ["source", "environment", "input"] : ["operation", "version", "environment", "input"];
  if (!hasOnlyKeys(args, allowed) || (args.version !== undefined && !bounded(args.version, 64))) invalid(tool);
  return {
    ...(hasSource ? { source: args.source as string } : { operation: args.operation as string }),
    ...(typeof args.version === "string" ? { version: args.version } : {}),
    environment: args.environment as string,
    input: args.input,
  };
}

function exactOptionalOperation(args: Record<string, unknown>, tool: AuthoringToolName): string | undefined {
  if (!hasOnlyKeys(args, ["operation"]) || (args.operation !== undefined && !bounded(args.operation, 256)))
    invalid(tool);
  return args.operation as string | undefined;
}

function exactTrialRead(args: Record<string, unknown>, tool: AuthoringToolName): { trial: string; after: number } {
  if (
    !hasOnlyKeys(args, ["trial", "after"]) ||
    !bounded(args.trial, 256) ||
    (args.after !== undefined && (!Number.isSafeInteger(args.after) || Number(args.after) < 0))
  )
    invalid(tool);
  return { trial: args.trial as string, after: typeof args.after === "number" ? args.after : 0 };
}

function exactTrialId(args: Record<string, unknown>, tool: AuthoringToolName): string {
  if (!hasOnlyKeys(args, ["trial"]) || !bounded(args.trial, 256)) invalid(tool);
  return args.trial as string;
}

function invalid(tool: AuthoringToolName): never {
  throw new InvalidMcpAuthoringArguments(tool);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const sourceProperty = {
  type: "string",
  minLength: 1,
  maxLength: 1_000_000,
  description: "Complete English Gherkin source",
} as const;
const sourceNameProperty = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  description: "Single .feature file name used in diagnostics and persistence",
} as const;
const operationProperty = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description: "Canonical Operation name",
} as const;
const procedureProperty = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description: "Canonical Procedure name",
} as const;
const versionProperty = { type: "string", minLength: 1, maxLength: 64, description: "Exact version" } as const;
const trialProperty = { type: "string", minLength: 1, maxLength: 256, description: "Trial identifier" } as const;

export function authoringTools(): readonly unknown[] {
  return [
    ...templateTools(),
    {
      name: "trust_environment_list",
      title: "List Environments",
      description:
        "List configured Environments and their ordinary values. Does not return credential names or secrets.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "trust_environment_save",
      title: "Save an Environment",
      description:
        "Create an Environment or replace its complete ordinary value map. Read the list first before editing. Omitted ordinary values are removed; credentials remain unchanged. Never send secrets in values.",
      inputSchema: {
        type: "object",
        properties: {
          environment: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
          values: {
            type: "object",
            propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,127}$" },
            additionalProperties: { type: "string", minLength: 1 },
          },
        },
        required: ["environment", "values"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "trust_environment_remove",
      title: "Remove an Environment",
      description:
        "Remove an Environment only when it has no attached credentials. Refuses instead of deleting secrets. An unknown Environment returns Removed: no.",
      inputSchema: {
        type: "object",
        properties: { environment: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" } },
        required: ["environment"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    catalogListTool(
      "trust_operation_list",
      "List Operations",
      "List persisted Operations with current catalog title, description and tags. Optionally search canonical name, title, description and tags.",
    ),
    identityTool(
      "trust_operation_read",
      "Read an Operation",
      "Read one persisted Operation with current catalog metadata and its original complete Gherkin source.",
      "operation",
    ),
    sourceTool(
      "trust_operation_compile",
      "Compile an Operation",
      "Compile Operation Gherkin without persisting or executing it.",
      false,
    ),
    sourceTool(
      "trust_operation_save",
      "Save an Operation",
      "Compile and persist Operation Gherkin in the configured writable catalog.",
      true,
    ),
    identityTool(
      "trust_operation_remove",
      "Request Operation removal",
      "Published Operation versions cannot be removed. This request returns an explicit immutability refusal, or unknown-operation when the version does not exist.",
      "operation",
    ),
    {
      name: "trust_operation_simulate",
      title: "Simulate an Operation",
      description:
        "Compile an Operation and evaluate its production mapping from supplied synthetic step results. This performs no external action.",
      inputSchema: {
        type: "object",
        properties: {
          source: sourceProperty,
          sourceName: sourceNameProperty,
          input: { type: "object", description: "Values matching the Operation Input schema" },
          environment: { type: "object", description: "Values matching the Operation Environment schema" },
          steps: { type: "object", description: "Exactly one synthetic result object for every Operation step" },
        },
        required: ["source", "input", "environment", "steps"],
        additionalProperties: false,
      },
    },
    {
      name: "trust_operation_environment_list",
      title: "List Operation environments",
      description:
        "List environments compatible with a persisted Operation or draft Operation source before starting a Trial.",
      inputSchema: {
        type: "object",
        oneOf: [
          { type: "object", properties: { source: sourceProperty }, required: ["source"], additionalProperties: false },
          {
            type: "object",
            properties: { operation: operationProperty, version: versionProperty },
            required: ["operation", "version"],
            additionalProperties: false,
          },
        ],
      },
    },
    {
      name: "trust_operation_trial_start",
      title: "Start an Operation Trial",
      description:
        "Run a persisted or draft Operation for real through the packaged runner in one declared environment. This is diagnostic execution, not a Plan Fact.",
      inputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              source: sourceProperty,
              environment: { type: "string", minLength: 1, maxLength: 256 },
              input: { type: "object" },
            },
            required: ["source", "environment", "input"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              operation: operationProperty,
              version: versionProperty,
              environment: { type: "string", minLength: 1, maxLength: 256 },
              input: { type: "object" },
            },
            required: ["operation", "version", "environment", "input"],
            additionalProperties: false,
          },
        ],
      },
    },
    {
      name: "trust_operation_trial_list",
      title: "List Operation Trials",
      description: "List recent Operation Trials, optionally filtered by Operation name.",
      inputSchema: { type: "object", properties: { operation: operationProperty }, additionalProperties: false },
    },
    {
      name: "trust_operation_trial_read",
      title: "Read an Operation Trial",
      description: "Read Trial state, outcome and diagnostics after an optional event cursor.",
      inputSchema: {
        type: "object",
        properties: {
          trial: trialProperty,
          after: { type: "integer", minimum: 0, description: "Return events after this sequence" },
        },
        required: ["trial"],
        additionalProperties: false,
      },
    },
    {
      name: "trust_operation_trial_cancel",
      title: "Cancel an Operation Trial",
      description: "Stop a currently starting or running Operation Trial.",
      inputSchema: {
        type: "object",
        properties: { trial: trialProperty },
        required: ["trial"],
        additionalProperties: false,
      },
    },
    catalogListTool(
      "trust_procedure_list",
      "List Procedures",
      "List published Procedures with current catalog title, description and tags. Optionally search canonical name, title, description and tags.",
    ),
    identityTool(
      "trust_published_procedure_read",
      "Read a published Procedure",
      "Read one published Procedure with current catalog metadata and its original complete Gherkin source.",
      "procedure",
    ),
    sourceTool(
      "trust_procedure_compile",
      "Compile a Procedure",
      "Compile Procedure Gherkin against the current Operation catalog without publishing it.",
      false,
    ),
    sourceTool(
      "trust_procedure_publish",
      "Publish a Procedure",
      "Compile and immutably publish Procedure Gherkin against the current Operation catalog.",
      false,
    ),
    {
      name: "trust_catalog_metadata_update",
      title: "Update catalog metadata",
      description:
        "Edit the current title, description and classification tags of one published Operation or Procedure version without changing its executable definition. Read the entry first for its metadata revision; send the complete replacement metadata with expectedRevision. An empty description clears it, and omitted tag keys are removed.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["operation", "procedure"] },
          name: { type: "string", minLength: 1, maxLength: 256, description: "Canonical catalog name" },
          version: versionProperty,
          expectedRevision: { type: "integer", minimum: 0, description: "Revision returned by a catalog read" },
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: {
            type: "string",
            maxLength: 10_000,
            description: "Existing human description; empty clears it",
          },
          classification: {
            type: "object",
            propertyNames: { pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" },
            additionalProperties: {
              type: "array",
              items: { type: "string", minLength: 1, pattern: "^[^\\s:]+$" },
              uniqueItems: true,
            },
            description: 'Complete map of editable classification tags; for example {"family":["delivery"]}',
          },
        },
        required: ["kind", "name", "version", "expectedRevision", "title", "classification"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function catalogListTool(name: AuthoringToolName, title: string, description: string): unknown {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 200, description: "All terms must match" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
}

function identityTool(
  name: AuthoringToolName,
  title: string,
  description: string,
  identity: "operation" | "procedure",
): unknown {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: {
        [identity]: identity === "operation" ? operationProperty : procedureProperty,
        version: versionProperty,
      },
      required: [identity, "version"],
      additionalProperties: false,
    },
  };
}

function sourceTool(name: AuthoringToolName, title: string, description: string, sourceNameRequired: boolean): unknown {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: { source: sourceProperty, sourceName: sourceNameProperty },
      required: sourceNameRequired ? ["source", "sourceName"] : ["source"],
      additionalProperties: false,
    },
  };
}
