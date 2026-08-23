import {
  type GherkinDocument,
  type Step,
  type Tag,
} from "@cucumber/messages";
import {
  documentRange,
  GherkinSyntaxError,
  hasGherkinTag,
  normalizeGherkinSource,
  parseGherkin,
  sourceLineRange,
  sourceValueRange,
  SentenceCursor,
  tokenizeSentence,
  type Located,
  type SentenceToken,
} from "@trust/gherkin";
import jsonata from "jsonata";

import type {
  HttpBody,
  HttpHeader,
  HttpMethod,
  HttpPathSegment,
  HttpQueryParameter,
  HttpValueSource,
} from "./http.js";
import { operationLanguage } from "./language.js";
import type {
  CompiledOperation,
  EnvironmentField,
  EnvironmentValueType,
  InputField,
  ObjectSchema,
  OperationStep,
  OperationValueDomain,
  OperationValueType,
  ProducedField,
  ValueSchema,
} from "./operation.js";
import type {
  OperationAnalysis,
  OperationCompilationErrorCode,
  OperationDocument,
  OperationEnvironmentSource,
  OperationInputSource,
  OperationProducedSource,
  OperationStepSource,
  SourceRange,
} from "./source.js";

const OPERATION_TAG = operationLanguage.tags.operation;
const VERSION_TAG = operationLanguage.tags.version;
const TRUST_DSL_TAG = operationLanguage.tags.dsl;
const TRUST_DSL_VERSION = operationLanguage.dslVersion;
const CLASSIFICATION_TAG = operationLanguage.tags.classification;
const CLASSIFICATION = /^@x-([a-z][a-z0-9]*(?:-[a-z0-9]+)*):([^\s:]+)$/;
const OPERATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SECRET_LIKE = /(?:^|[^a-z0-9])(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{8,}|bearer\s+[a-z0-9._-]{8,})/i;
const ENUM_DOMAIN = /^enum "[^"]+"(?:, "[^"]+")*$/;
const ENUM_VALUE = /"([^"]+)"/g;
const VALUE_TYPES = new Set<OperationValueType>(operationLanguage.valueTypes);
const ENVIRONMENT_TYPES = new Set<EnvironmentValueType>(operationLanguage.environmentTypes);
const CARDINALITIES = new Set<"one" | "many">(operationLanguage.cardinalities);
const JSONATA_NODE_TYPES = new Set<string>(operationLanguage.jsonata.nodeTypes);
const JSONATA_FUNCTIONS = new Set<string>(operationLanguage.jsonata.functions);
const JSONATA_BINARY_OPERATORS = new Set<string>(operationLanguage.jsonata.binaryOperators);
const [STEPS_ROOT, INPUT_ROOT, ENVIRONMENT_ROOT, EXECUTION_ROOT] = operationLanguage.jsonata.roots;

export class OperationCompilationError extends Error {
  constructor(
    readonly code: OperationCompilationErrorCode,
    message: string,
    readonly sourceName?: string,
    readonly location?: { readonly line: number; readonly column: number },
  ) {
    super(message);
    this.name = "OperationCompilationError";
  }
}

export interface OperationCompilationInput {
  readonly source: string;
  readonly sourceName?: string;
}

export function isOperationSource(source: string): boolean {
  const normalized = normalizeGherkinSource(source);
  try {
    return parseGherkin(normalized).feature?.tags
      .some((tag) => tag.name.startsWith(OPERATION_TAG)) ?? false;
  } catch (error) {
    if (error instanceof GherkinSyntaxError) return hasGherkinTag(source, OPERATION_TAG);
    throw error;
  }
}

interface CompileContext {
  readonly sourceName: string;
  readonly source: string;
}

interface ParsedOperationSource {
  readonly context: CompileContext;
  readonly gherkin: GherkinDocument;
  readonly document?: OperationDocument;
}

export function compileOperation(input: OperationCompilationInput): CompiledOperation {
  return compileOperationDocument(input).compiled;
}

export function analyzeOperation(input: OperationCompilationInput): OperationAnalysis {
  const sourceName = input.sourceName ?? "<operation>";
  const source = normalizeGherkinSource(input.source);
  let parsed: ParsedOperationSource;
  try {
    parsed = parseOperationSource({ source, sourceName });
  } catch (error) {
    if (!(error instanceof OperationCompilationError)) throw error;
    return {
      diagnostics: [{
        code: error.code,
        message: error.message,
        sourceName,
        range: sourceLineRange(source, error.location),
      }],
    };
  }
  try {
    return compileParsedOperation(parsed);
  } catch (error) {
    if (!(error instanceof OperationCompilationError)) throw error;
    return {
      ...(parsed.document ? { document: parsed.document } : {}),
      diagnostics: [{
        code: error.code,
        message: error.message,
        sourceName,
        range: sourceLineRange(source, error.location),
      }],
    };
  }
}

function compileOperationDocument(
  input: OperationCompilationInput,
): {
  readonly document: OperationDocument;
  readonly diagnostics: readonly [];
  readonly compiled: CompiledOperation;
} {
  return compileParsedOperation(parseOperationSource(input));
}

function parseOperationSource(input: OperationCompilationInput): ParsedOperationSource {
  const source = normalizeGherkinSource(input.source);
  const context = { sourceName: input.sourceName ?? "<operation>", source };
  let gherkin: GherkinDocument;
  try {
    gherkin = parseGherkin(source);
  } catch (error) {
    if (!(error instanceof GherkinSyntaxError)) throw error;
    fail(
      context,
      "invalid-operation",
      `Operation is not valid Gherkin: ${error.message}`,
      error.location ? { location: error.location } : undefined,
    );
  }
  const document = readOperationDocument(gherkin, context);
  return {
    context,
    gherkin,
    ...(document ? { document } : {}),
  };
}

function compileParsedOperation(
  parsed: ParsedOperationSource,
): {
  readonly document: OperationDocument;
  readonly diagnostics: readonly [];
  readonly compiled: CompiledOperation;
} {
  const { context, gherkin, document } = parsed;
  const { source } = context;
  assertNoSecretLikeValue(source, context);
  const feature = gherkin.feature;
  if (!feature || feature.language !== "en") {
    fail(context, "invalid-operation", "Operation must contain one English Gherkin Feature");
  }
  if (feature.children.some((child) => child.rule)) {
    fail(context, "invalid-operation", "Rules are outside the closed Operation grammar", feature);
  }

  const description = readDescription(feature.description);
  const operation = readUniqueTag(feature.tags, OPERATION_TAG, "Operation", context, feature);
  if (!OPERATION_NAME.test(operation)) {
    fail(
      context,
      "invalid-identifier",
      `Operation "${operation}" must use the canonical <domain>.<action> form`,
      feature,
    );
  }
  const version = readUniqueTag(feature.tags, VERSION_TAG, "version", context, feature);
  if (!SEMANTIC_VERSION.test(version)) {
    fail(context, "invalid-identifier", `Operation version "${version}" must be semantic`, feature);
  }
  const trustDsl = readUniqueTag(feature.tags, TRUST_DSL_TAG, "TRUST DSL version", context, feature);
  if (trustDsl !== TRUST_DSL_VERSION) {
    fail(
      context,
      "invalid-operation",
      `TRUST DSL version "${trustDsl}" is unsupported; expected "${TRUST_DSL_VERSION}"`,
      feature,
    );
  }
  assertOnlyTags(feature.tags, [OPERATION_TAG, VERSION_TAG, TRUST_DSL_TAG, CLASSIFICATION_TAG], context, feature);
  const classification = readClassification(feature.tags, context, feature);

  const backgrounds = feature.children.flatMap((child) => child.background ? [child.background] : []);
  if (backgrounds.length !== 1 || !backgrounds[0]) {
    fail(context, "invalid-operation", "Operation must declare exactly one Background", feature);
  }
  const operationInterface = parseInterface(backgrounds[0].steps, context);

  const scenarios = feature.children.flatMap((child) => child.scenario ? [child.scenario] : []);
  if (scenarios.length !== 1 || !scenarios[0] || scenarios[0].name !== "Run") {
    fail(context, "invalid-operation", "Operation must declare exactly one Scenario named Run", feature);
  }
  if (scenarios[0].keyword !== "Scenario" || scenarios[0].examples.length !== 0) {
    fail(context, "invalid-operation", "Scenario Outline is outside the closed Operation grammar", scenarios[0]);
  }
  if (scenarios[0].tags.length !== 0) {
    fail(context, "invalid-operation", "Operation Scenario tags are outside the closed grammar", scenarios[0]);
  }
  const run = parseRun(
    scenarios[0].steps,
    operationInterface.input,
    operationInterface.environment,
    context,
  );
  validateProduce(
    run.expression,
    run.steps,
    operationInterface.input,
    operationInterface.environment,
    operationInterface.producedFields,
    context,
  );

  const compiled: CompiledOperation = {
    contract: "trust.compiled-operation@1",
    operation,
    version,
    title: feature.name,
    ...(description === undefined ? {} : { description }),
    source,
    input: compileInputSchema(operationInterface.input),
    environment: compileEnvironmentSchema(operationInterface.environment),
    steps: run.steps,
    produce: { language: "jsonata", expression: run.expression },
    produced: compileProducedSchema(operationInterface.producedFields),
    ...(Object.keys(classification).length > 0 ? { classification } : {}),
  };
  if (!document) {
    fail(context, "invalid-operation", "Operation source model is unavailable", feature);
  }
  return {
    document,
    diagnostics: [],
    compiled,
  };
}

function readOperationDocument(
  gherkin: GherkinDocument,
  context: CompileContext,
): OperationDocument | undefined {
  const feature = gherkin.feature;
  if (!feature) return undefined;

  const operationTag = feature.tags.find((tag) => tag.name.startsWith(OPERATION_TAG));
  const versionTag = feature.tags.find((tag) => tag.name.startsWith(VERSION_TAG));
  const environment: OperationEnvironmentSource[] = [];
  const input: OperationInputSource[] = [];
  const produced: OperationProducedSource[] = [];
  const steps: OperationStepSource[] = [];

  for (const background of feature.children.flatMap((child) => child.background ? [child.background] : [])) {
    for (const step of background.steps) {
      const rows = step.dataTable?.rows.slice(1) ?? [];
      if (step.text === operationLanguage.phrases.environment) {
        for (const row of rows) {
          const nameCell = row.cells[0];
          const name = nameCell?.value.trim() ?? "";
          const type = row.cells[1]?.value.trim();
          if (!nameCell || !isEnvironmentValueType(type)) continue;
          environment.push({
            name,
            type,
            range: sourceLineRange(context.source, row.location),
            selectionRange: sourceValueRange(context.source, nameCell, name),
          });
        }
        continue;
      }
      if (step.text === operationLanguage.phrases.input) {
        for (const row of rows) {
          const nameCell = row.cells[0];
          const name = nameCell?.value.trim() ?? "";
          const type = row.cells[1]?.value.trim();
          const cardinality = row.cells[2]?.value.trim();
          if (!nameCell || !isOperationValueType(type) || !isCardinality(cardinality)) continue;
          input.push({
            name,
            type,
            cardinality,
            range: sourceLineRange(context.source, row.location),
            selectionRange: sourceValueRange(context.source, nameCell, name),
          });
        }
        continue;
      }
      if (step.text === operationLanguage.phrases.produced) {
        for (const row of rows) {
          const nameCell = row.cells[0];
          const name = nameCell?.value.trim() ?? "";
          const type = row.cells[1]?.value.trim();
          const cardinality = row.cells[2]?.value.trim();
          const domain = isOperationValueType(type)
            ? readSourceDomain(row.cells[3]?.value.trim() ?? "", type)
            : undefined;
          if (!nameCell || !isOperationValueType(type) || !domain || !isCardinality(cardinality)) continue;
          produced.push({
            name,
            type,
            cardinality,
            domain,
            range: sourceLineRange(context.source, row.location),
            selectionRange: sourceValueRange(context.source, nameCell, name),
          });
        }
      }
    }
  }

  for (const scenario of feature.children.flatMap((child) => child.scenario ? [child.scenario] : [])) {
    for (const step of scenario.steps) {
      const parsed = parseRunStepSentence(step.text);
      if (!parsed || parsed.type === "shell-exits" || parsed.type === "http-statuses") continue;
      steps.push({
        name: parsed.name,
        type: parsed.type === "http-malformed" ? "http" : parsed.type,
        range: sourceLineRange(context.source, step.location),
        selectionRange: sourceValueRange(context.source, step, parsed.name),
      });
    }
  }

  const documentDescription = readDescription(feature.description);
  return {
    kind: "operation",
    ...(operationTag ? { operation: operationTag.name.slice(OPERATION_TAG.length) } : {}),
    ...(versionTag ? { version: versionTag.name.slice(VERSION_TAG.length) } : {}),
    title: feature.name,
    ...(documentDescription === undefined ? {} : { description: documentDescription }),
    range: documentRange(context.source),
    selectionRange: operationTag
      ? tagValueRange(context.source, operationTag, OPERATION_TAG)
      : sourceValueRange(context.source, feature, feature.name),
    environment,
    input,
    steps,
    produced,
  };
}

function readSourceDomain(
  value: string,
  type: OperationValueType,
): OperationValueDomain | undefined {
  if (value === "any") return { kind: "any" };
  if (type !== "string" || !ENUM_DOMAIN.test(value)) return undefined;
  return {
    kind: "enum",
    values: [...value.matchAll(ENUM_VALUE)].map((item) => item[1] ?? ""),
  };
}

function isOperationValueType(value: string | undefined): value is OperationValueType {
  return value !== undefined && VALUE_TYPES.has(value as OperationValueType);
}

function isEnvironmentValueType(value: string | undefined): value is EnvironmentValueType {
  return value !== undefined && ENVIRONMENT_TYPES.has(value as EnvironmentValueType);
}

function isCardinality(value: string | undefined): value is "one" | "many" {
  return value !== undefined && CARDINALITIES.has(value as "one" | "many");
}

function tagValueRange(source: string, tag: Tag, prefix: string): SourceRange {
  return sourceValueRange(source, tag, tag.name.slice(prefix.length), prefix.length);
}

function parseInterface(steps: readonly Step[], context: CompileContext): {
  readonly input: Readonly<Record<string, InputField>>;
  readonly environment: Readonly<Record<string, EnvironmentField>>;
  readonly producedFields: Readonly<Record<string, ProducedField>>;
} {
  const input = new Map<string, InputField>();
  const environment = new Map<string, EnvironmentField>();
  const producedFields = new Map<string, ProducedField>();
  let hasEnvironment = false;
  let hasInputs = false;
  let hasProduces = false;

  for (const step of steps) {
    const keyword = step.keyword.trim();
    if (keyword !== "Given" && keyword !== "And") {
      fail(context, "invalid-operation", "Operation interface must use Given or And", step);
    }
    if (step.text === operationLanguage.phrases.environment) {
      if (hasEnvironment) {
        fail(context, "invalid-operation", "Operation repeats Environment", step);
      }
      hasEnvironment = true;
      for (const row of requireTable(step, ["name", "type"], context)) {
        const name = row.cells[0]?.value.trim() ?? "";
        const type = row.cells[1]?.value.trim() as EnvironmentValueType;
        assertFieldName(name, "Environment name", context, row);
        if (environment.has(name)) {
          fail(context, "duplicate-environment", `Environment "${name}" is repeated`, row);
        }
        if (!isEnvironmentValueType(type)) {
          fail(context, "invalid-operation", `Environment "${name}" has invalid type "${type}"`, row);
        }
        environment.set(name, { type });
      }
      continue;
    }
    if (step.text === operationLanguage.phrases.input) {
      if (hasInputs) fail(context, "invalid-operation", "Operation repeats Input", step);
      hasInputs = true;
      for (const row of requireTable(step, ["input", "type", "cardinality"], context)) {
        const name = row.cells[0]?.value.trim() ?? "";
        const type = row.cells[1]?.value.trim() as OperationValueType;
        const cardinality = row.cells[2]?.value.trim() ?? "";
        assertFieldName(name, "Input", context, row);
        if (input.has(name)) fail(context, "duplicate-input", `Input "${name}" is repeated`, row);
        assertValueType(type, "Input", name, context, row);
        const parsedCardinality = parseCardinality(cardinality, context, row);
        input.set(name, { type, cardinality: parsedCardinality });
      }
      continue;
    }
    if (step.text === operationLanguage.phrases.produced) {
      if (hasProduces) fail(context, "invalid-operation", "Operation repeats Produce fields", step);
      hasProduces = true;
      for (const row of requireTable(step, ["field", "type", "cardinality", "domain"], context)) {
        const name = row.cells[0]?.value.trim() ?? "";
        const type = row.cells[1]?.value.trim() as OperationValueType;
        const cardinality = row.cells[2]?.value.trim() ?? "";
        const domain = row.cells[3]?.value.trim() ?? "";
        assertFieldName(name, "Produced field", context, row);
        if (producedFields.has(name)) {
          fail(context, "duplicate-produced-field", `Produced field "${name}" is repeated`, row);
        }
        assertValueType(type, "Produced field", name, context, row);
        const parsedCardinality = parseCardinality(cardinality, context, row);
        const parsedDomain = parseDomain(domain, type, context, row);
        producedFields.set(name, {
          type,
          cardinality: parsedCardinality,
          domain: parsedDomain,
        });
      }
      continue;
    }
    fail(context, "invalid-operation", `Unknown Operation interface step "${step.text}"`, step);
  }

  if (!hasEnvironment) {
    fail(context, "invalid-operation", "Operation must declare Environment");
  }
  if (!hasProduces || producedFields.size === 0) {
    fail(context, "invalid-operation", "Operation must declare produced fields");
  }
  return {
    input: Object.fromEntries(input),
    environment: Object.fromEntries(environment),
    producedFields: Object.fromEntries(producedFields),
  };
}

function parseRun(
  steps: readonly Step[],
  input: Readonly<Record<string, InputField>>,
  environment: Readonly<Record<string, EnvironmentField>>,
  context: CompileContext,
): {
  readonly steps: readonly OperationStep[];
  readonly expression: string;
} {
  const compiled: OperationStep[] = [];
  const names = new Set<string>();
  let expression: string | undefined;

  for (const [index, step] of steps.entries()) {
    const parsed = parseRunStepSentence(step.text);
    if (parsed?.type === "shell") {
      const keyword = step.keyword.trim();
      if (keyword !== "When" && keyword !== "And") {
        fail(context, "unknown-step", "Shell must use When or And", step);
      }
      if (expression !== undefined) {
        fail(context, "unknown-step", "Shell cannot run after Produce", step);
      }
      const { name, executable, environment: environmentName, appendInput } = parsed;
      if (names.has(name)) fail(context, "duplicate-step", `Step "${name}" is repeated`, step);
      if (!Object.hasOwn(environment, environmentName)) {
        fail(
          context,
          "unknown-environment",
          `Shell "${name}" uses undeclared Environment "${environmentName}"`,
          step,
        );
      }
      if (appendInput !== undefined) assertStringInput(`Shell "${name}"`, "directory", appendInput, input, context, step);
      if (environment[environmentName]?.type !== "directory") {
        fail(
          context,
          "invalid-operation",
          `Shell "${name}" requires Environment "${environmentName}" to be a directory`,
          step,
        );
      }
      const table = step.dataTable;
      if (!table) fail(context, "invalid-operation", `Shell "${name}" requires an argument table`, step);
      const headers = table.rows[0]?.cells.map((cell) => cell.value.trim()) ?? [];
      if (headers.length !== 1 && headers.length !== 2) {
        fail(context, "invalid-operation", `Shell "${name}" argument table must use argument or argument | source`, step);
      }
      if (headers[0] !== "argument" || (headers.length === 2 && headers[1] !== "source")) {
        fail(context, "invalid-operation", `Shell "${name}" argument table must use argument or argument | source`, step);
      }
      const arguments_ = table.rows.slice(1).map((row) => {
        if (row.cells.length !== headers.length) {
          fail(context, "invalid-operation", `Shell "${name}" argument row has the wrong number of cells`, row);
        }
        const value = row.cells[0]?.value ?? "";
        const source = row.cells[1]?.value.trim() ?? "literal";
        if (source === "literal") return { kind: "literal" as const, value };
        const parsedSource = parseArgumentSource(source);
        if (!parsedSource) {
          fail(context, "invalid-operation", `Shell "${name}" argument source "${source}" must be literal, Input "<name>", literal + Input "<name>", Execution "id" or literal + Execution "id"`, row);
        }
        if (parsedSource.kind === "input") {
          assertStringInput(`Shell "${name}"`, "argument", parsedSource.input, input, context, row);
        }
        if (value === "") {
          if (parsedSource.prefixed) {
            fail(context, "invalid-operation", `Shell "${name}" prefixed argument requires a non-empty argument cell`, row);
          }
        }
        if (parsedSource.kind === "input") {
          return {
            kind: "input" as const,
            input: parsedSource.input,
            ...(parsedSource.prefixed ? { prefix: value } : {}),
          };
        }
        return {
          kind: "execution" as const,
          field: parsedSource.field,
          ...(parsedSource.prefixed ? { prefix: value } : {}),
        };
      });
      names.add(name);
      compiled.push({
        name,
        type: "shell",
        shell: {
          executable,
          arguments: arguments_,
          cwd: { environment: environmentName, ...(appendInput === undefined ? {} : { appendInput }) },
          acceptedExits: [{ code: 0 }],
        },
      });
      continue;
    }

    if (parsed?.type === "shell-exits") {
      const keyword = step.keyword.trim();
      if (keyword !== "And" || expression !== undefined) {
        fail(context, "unknown-step", "Shell accepted exits must follow a Shell step", step);
      }
      const index = compiled.findIndex((candidate) => candidate.type === "shell" && candidate.name === parsed.name);
      const existing = compiled[index];
      if (!existing || existing.type !== "shell") {
        fail(context, "invalid-operation", `Shell "${parsed.name}" is unknown`, step);
      }
      const exits = requireTable(step, ["exit code", "stdout contains", "stderr contains"], context).map((row) => {
        const raw = row.cells[0]?.value.trim() ?? "";
        const code = Number(raw);
        if (!Number.isInteger(code) || code < 0 || code > 255) {
          fail(context, "invalid-operation", `Shell exit code "${raw}" must be an integer from 0 to 255`, row);
        }
        const stdoutContains = row.cells[1]?.value ?? "";
        const stderrContains = row.cells[2]?.value ?? "";
        return {
          code,
          ...(stdoutContains === "" ? {} : { stdoutContains }),
          ...(stderrContains === "" ? {} : { stderrContains }),
        };
      });
      const keys = exits.map((exit) => JSON.stringify(exit));
      if (exits.length === 0 || new Set(keys).size !== keys.length) {
        fail(context, "invalid-operation", `Shell "${parsed.name}" accepted exits must be non-empty and unique`, step);
      }
      compiled[index] = {
        ...existing,
        shell: { ...existing.shell, acceptedExits: exits },
      };
      continue;
    }

    if (parsed?.type === "file-read") {
      const keyword = step.keyword.trim();
      if (keyword !== "When" && keyword !== "And") {
        fail(context, "unknown-step", "File must use When or And", step);
      }
      if (expression !== undefined) {
        fail(context, "unknown-step", "File cannot read after Produce", step);
      }
      if (step.dataTable || step.docString) {
        fail(context, "unknown-step", "File does not accept a table or DocString", step);
      }
      const { name, path, format, environment: environmentName, appendInput } = parsed;
      if (names.has(name)) fail(context, "duplicate-step", `Step "${name}" is repeated`, step);
      if (!Object.hasOwn(environment, environmentName)) {
        fail(
          context,
          "unknown-environment",
          `File "${name}" uses undeclared Environment "${environmentName}"`,
          step,
        );
      }
      if (appendInput !== undefined) assertStringInput(`File "${name}"`, "directory", appendInput, input, context, step);
      if (environment[environmentName]?.type !== "directory") {
        fail(
          context,
          "invalid-operation",
          `File "${name}" requires Environment "${environmentName}" to be a directory`,
          step,
        );
      }
      assertRelativeFilePath(path, context, step);
      names.add(name);
      compiled.push({
        name,
        type: "file-read",
        file: {
          relativePath: path,
          root: { environment: environmentName, ...(appendInput === undefined ? {} : { appendInput }) },
          format,
        },
      });
      continue;
    }

    if (parsed?.type === "http") {
      const keyword = step.keyword.trim();
      if (keyword !== "When" && keyword !== "And") {
        fail(context, "unknown-step", "HTTP must use When or And", step);
      }
      if (expression !== undefined) {
        fail(context, "unknown-step", "HTTP cannot run after Produce", step);
      }
      if (step.dataTable || (parsed.body?.source !== "jsonata" && step.docString)) {
        fail(context, "unknown-step", "HTTP accepts a DocString only for a JSONata body", step);
      }
      if (parsed.body?.source === "jsonata" && !step.docString) {
        fail(context, "unknown-step", "HTTP JSONata body requires one DocString", step);
      }
      const { name, method, environment: environmentName, format, path, query, headers } = parsed;
      if (names.has(name)) fail(context, "duplicate-step", `Step "${name}" is repeated`, step);
      if (!Object.hasOwn(environment, environmentName)) {
        fail(
          context,
          "unknown-environment",
          `HTTP "${name}" uses undeclared Environment "${environmentName}"`,
          step,
        );
      }
      if (environment[environmentName]?.type !== "url") {
        fail(
          context,
          "invalid-operation",
          `HTTP "${name}" requires Environment "${environmentName}" to be a url`,
          step,
        );
      }
      for (const segment of path) {
        if (segment.kind === "input") assertStringInput(`HTTP "${name}"`, "path", segment.input, input, context, step);
      }
      for (const parameter of query) {
        assertHttpValueSource(`HTTP "${name}"`, "query", parameter.source, input, environment, context, step);
      }
      for (const header of headers) {
        if (!HTTP_HEADER_NAME.test(header.name)) {
          fail(context, "invalid-operation", `HTTP "${name}" header name "${header.name}" is invalid`, step);
        }
        assertHttpValueSource(`HTTP "${name}"`, "header", header.source, input, environment, context, step);
      }
      if (new Set(headers.map((header) => header.name)).size !== headers.length) {
        fail(context, "invalid-operation", `HTTP "${name}" repeats a header name`, step);
      }
      let body: HttpBody | undefined;
      if (parsed.body?.source === "input") {
        if (Object.keys(input).length === 0) fail(context, "invalid-operation", `HTTP "${name}" cannot send an empty Input body`, step);
        body = { format: "json", source: "input" };
      } else if (parsed.body?.source === "jsonata") {
        const bodyExpression = step.docString?.content.trim() ?? "";
        if (bodyExpression === "") fail(context, "invalid-operation", `HTTP "${name}" JSONata body cannot be empty`, step);
        validateJsonataExpression(`HTTP "${name}" JSONata body`, bodyExpression, compiled, input, environment, context);
        body = { format: "json", source: "jsonata", expression: bodyExpression };
      } else if (parsed.body?.source !== undefined) {
        assertHttpValueSource(`HTTP "${name}"`, "body", parsed.body.source, input, environment, context, step);
        body = { format: "text", source: parsed.body.source };
      }
      if (method === "CONNECT" && (path.length > 0 || query.length > 0 || body !== undefined)) {
        fail(context, "invalid-operation", `HTTP "${name}" CONNECT accepts headers but no path, query or body`, step);
      }
      names.add(name);
      compiled.push({
        name,
        type: "http",
        http: {
          method,
          url: { environment: environmentName },
          path,
          query,
          headers,
          ...(body === undefined ? {} : { body }),
          format,
        },
      });
      continue;
    }

    if (parsed?.type === "http-malformed") {
      fail(context, "unknown-step", `HTTP "${parsed.name}" ${parsed.reason}`, step);
    }

    if (parsed?.type === "http-statuses") {
      const keyword = step.keyword.trim();
      if (keyword !== "And" || expression !== undefined || step.docString) {
        fail(context, "unknown-step", "HTTP accepted statuses must follow an HTTP step", step);
      }
      const previous = index > 0 ? parseRunStepSentence(steps[index - 1]!.text) : undefined;
      if (previous?.type !== "http" || previous.name !== parsed.name) {
        fail(context, "invalid-operation", `HTTP "${parsed.name}" accepted statuses must immediately follow that HTTP step`, step);
      }
      const compiledIndex = compiled.findIndex((candidate) => candidate.type === "http" && candidate.name === parsed.name);
      const existing = compiled[compiledIndex];
      if (!existing || existing.type !== "http") {
        fail(context, "invalid-operation", `HTTP "${parsed.name}" is unknown`, step);
      }
      const statuses = requireTable(step, ["status"], context).map((row) => {
        const raw = row.cells[0]?.value.trim() ?? "";
        const status = Number(raw);
        if (!Number.isInteger(status) || (status !== 101 && (status < 200 || status > 599))) {
          fail(context, "invalid-operation", `HTTP status "${raw}" must be terminal: 101 or an integer from 200 to 599`, row);
        }
        return status;
      });
      if (statuses.length === 0 || new Set(statuses).size !== statuses.length) {
        fail(context, "invalid-operation", `HTTP "${parsed.name}" accepted statuses must be non-empty and unique`, step);
      }
      compiled[compiledIndex] = { ...existing, http: { ...existing.http, acceptedStatuses: statuses } };
      continue;
    }

    if (step.text === operationLanguage.phrases.produce) {
      if (step.keyword.trim() !== "Then" || step.dataTable || !step.docString) {
        fail(context, "unknown-step", "Produce with JSONata must use Then and one DocString", step);
      }
      if (expression !== undefined) {
        fail(context, "unknown-step", "Operation repeats Produce with JSONata", step);
      }
      if (index !== steps.length - 1) {
        fail(context, "unknown-step", "Produce with JSONata must be the final step", step);
      }
      expression = step.docString.content.trim();
      if (expression === "") {
        fail(context, "invalid-operation", "Produce with JSONata cannot be empty", step);
      }
      continue;
    }

    fail(context, "unknown-step", `Unknown Operation step "${step.text}"`, step);
  }

  if (compiled.length === 0) fail(context, "invalid-operation", "Operation must declare at least one step");
  if (expression === undefined) fail(context, "invalid-operation", "Operation must Produce with JSONata");
  return { steps: compiled, expression };
}

type ParsedRunStepSentence =
  | {
      readonly type: "shell";
      readonly name: string;
      readonly executable: string;
      readonly environment: string;
      readonly appendInput?: string;
    }
  | {
      readonly type: "shell-exits";
      readonly name: string;
    }
  | {
      readonly type: "file-read";
      readonly name: string;
      readonly path: string;
      readonly format: "text" | "json";
      readonly environment: string;
      readonly appendInput?: string;
    }
  | ParsedHttpSentence
  | {
      readonly type: "http-statuses";
      readonly name: string;
    };

type ParsedHttpBody =
  | { readonly source: "input" }
  | { readonly source: "jsonata" }
  | { readonly source: HttpValueSource };

type ParsedHttpSentence =
  | {
      readonly type: "http";
      readonly name: string;
      readonly method: HttpMethod;
      readonly format: "text" | "json" | "none";
      readonly environment: string;
      readonly path: readonly HttpPathSegment[];
      readonly query: readonly HttpQueryParameter[];
      readonly headers: readonly HttpHeader[];
      readonly body?: ParsedHttpBody;
    }
  | {
      /** An `HTTP "<name>" sends …` sentence whose clauses are malformed or misordered. */
      readonly type: "http-malformed";
      readonly name: string;
      readonly reason: string;
    };

type ParsedArgumentSource =
  | { readonly kind: "input"; readonly input: string; readonly prefixed: boolean }
  | { readonly kind: "execution"; readonly field: "id"; readonly prefixed: boolean };

/** `Input "<name>"`, `Execution "id"`, or their literal-prefixed forms. */
function parseArgumentSource(source: string): ParsedArgumentSource | undefined {
  const tokens = tryTokenize(source);
  if (!tokens) return undefined;
  const cursor = new SentenceCursor(tokens);
  const prefixed = cursor.takeWords("literal", "+");
  if (cursor.takeText("Input")) {
    const input = takeField(cursor);
    return input && cursor.done ? { kind: "input", input, prefixed } : undefined;
  }
  if (!cursor.takeText("Execution")) return undefined;
  const field = takeField(cursor);
  return field === "id" && cursor.done ? { kind: "execution", field, prefixed } : undefined;
}

function tryTokenize(source: string): readonly SentenceToken[] | undefined {
  try {
    return tokenizeSentence(source);
  } catch {
    return undefined;
  }
}

const takeField = (cursor: SentenceCursor): string | undefined => cursor.takeQuoted((value) => FIELD_NAME.test(value));
const takeFormat = (cursor: SentenceCursor): "text" | "json" | undefined => {
  const format = cursor.takeOneOf(operationLanguage.formats);
  return format?.toLowerCase() as "text" | "json" | undefined;
};

/** Optional `and Input "<name>"` closing a `from Environment` clause; `undefined` when absent, `null` when malformed. */
function takeAppendInput(cursor: SentenceCursor): string | undefined | null {
  if (cursor.done) return undefined;
  if (!cursor.takeWords("and", "Input")) return null;
  const input = takeField(cursor);
  return input && cursor.done ? input : null;
}

function parseRunStepSentence(source: string): ParsedRunStepSentence | undefined {
  const tokens = tryTokenize(source);
  if (!tokens) return undefined;
  const cursor = new SentenceCursor(tokens);

  if (cursor.takeText("Shell")) {
    const name = takeField(cursor);
    if (!name) return undefined;
    if (cursor.takeText("accepts")) {
      return cursor.takeText("exits") && cursor.done ? { type: "shell-exits", name } : undefined;
    }
    if (!cursor.takeText("runs")) return undefined;
    const executable = cursor.takeQuoted();
    if (!executable || !cursor.takeWords("with", "cwd", "from", "Environment")) return undefined;
    const environment = takeField(cursor);
    if (!environment) return undefined;
    const appendInput = takeAppendInput(cursor);
    if (appendInput === null) return undefined;
    return { type: "shell", name, executable, environment, ...(appendInput === undefined ? {} : { appendInput }) };
  }

  if (cursor.takeText("File")) {
    const name = takeField(cursor);
    if (!name || !cursor.takeText("reads")) return undefined;
    const path = cursor.takeQuoted();
    if (!path || !cursor.takeText("as")) return undefined;
    const format = takeFormat(cursor);
    if (!format || !cursor.takeWords("from", "Environment")) return undefined;
    const environment = takeField(cursor);
    if (!environment) return undefined;
    const appendInput = takeAppendInput(cursor);
    if (appendInput === null) return undefined;
    return { type: "file-read", name, path, format, environment, ...(appendInput === undefined ? {} : { appendInput }) };
  }

  if (cursor.takeText("HTTP")) {
    const name = takeField(cursor);
    if (!name) return undefined;
    if (cursor.takeText("accepts")) {
      return cursor.takeText("statuses") && cursor.done ? { type: "http-statuses", name } : undefined;
    }
    return cursor.takeText("sends") ? parseHttpSentence(cursor, name) : undefined;
  }
  return undefined;
}

/**
 * `HTTP "<n>" sends "<METHOD>" to Environment "<url>"`, followed by structured path,
 * query, header and optional body clauses, then `and reads JSON|Text|no body`.
 */
function parseHttpSentence(cursor: SentenceCursor, name: string): ParsedHttpSentence {
  const expected = `HTTP "${name}" sends "<METHOD>" to Environment "<url>" […] and reads JSON|Text|no body`;
  const malformed = (reason: string): ParsedHttpSentence => ({ type: "http-malformed", name, reason });
  const rawMethod = cursor.takeQuoted();
  const method = operationLanguage.httpMethods.find((candidate) => candidate === rawMethod);
  if (!method) return malformed(`method "${rawMethod ?? ""}" is not registered for application requests`);
  if (!cursor.takeWords("to", "Environment")) return malformed(`sentence must be: ${expected}`);
  const environment = takeField(cursor);
  if (!environment) return malformed(`sentence must be: ${expected}`);

  const path: HttpPathSegment[] = [];
  if (cursor.takeText("appending")) {
    if (cursor.takeText("Input")) {
      const input = takeField(cursor);
      if (!input) return malformed(`appending Input expects "<name>"`);
      path.push({ kind: "input", input });
    } else if (cursor.takeText("literal")) {
      const value = cursor.takeQuoted();
      if (!value) return malformed(`appending literal expects a non-empty "<segment>"`);
      path.push({ kind: "literal", value });
    } else {
      return malformed(`appending expects Input "<name>" or literal "<segment>"`);
    }
    while (true) {
      if (cursor.takeWords("and", "Input")) {
        const input = takeField(cursor);
        if (!input) return malformed(`appending and Input expects "<name>"`);
        path.push({ kind: "input", input });
        continue;
      }
      if (cursor.takeWords("and", "literal")) {
        const value = cursor.takeQuoted();
        if (!value) return malformed(`appending and literal expects a non-empty "<segment>"`);
        path.push({ kind: "literal", value });
        continue;
      }
      break;
    }
  }

  const query: HttpQueryParameter[] = [];
  while (cursor.takeWords("with", "query")) {
    const parameterName = cursor.takeQuoted();
    if (!parameterName) return malformed(`with query expects a non-empty "<name>"`);
    const source = parseHttpValueSource(cursor);
    if (!source) return malformed(`with query "${parameterName}" expects from Input|Environment "<name>" or as "<literal>"`);
    query.push({ name: parameterName, source });
  }

  const headers: HttpHeader[] = [];
  while (cursor.takeWords("with", "header")) {
    const headerName = cursor.takeQuoted();
    if (!headerName) return malformed(`with header expects a non-empty "<name>"`);
    const source = parseHttpValueSource(cursor);
    if (!source) return malformed(`with header "${headerName}" expects from Input|Environment "<name>" or as "<literal>"`);
    headers.push({ name: headerName.toLowerCase(), source });
  }

  let body: ParsedHttpBody | undefined;
  if (cursor.takeText("with")) {
    if (cursor.takeWords("Input", "as", "JSON", "body")) {
      body = { source: "input" };
    } else if (cursor.takeWords("JSONata", "body")) {
      body = { source: "jsonata" };
    } else if (cursor.takeWords("Text", "body")) {
      const source = parseHttpValueSource(cursor);
      if (!source) return malformed(`with Text body expects from Input|Environment "<name>" or as "<literal>"`);
      body = { source };
    } else {
      return malformed(`with expects query, header, Input as JSON body, JSONata body or Text body`);
    }
  }

  if (!cursor.takeWords("and", "reads")) return malformed(`sentence must end with and reads JSON|Text|no body: ${expected}`);
  let format: "text" | "json" | "none" | undefined;
  if (cursor.takeWords("no", "body")) format = "none";
  else format = takeFormat(cursor);
  if (!format || !cursor.done) return malformed(`sentence must end with and reads JSON|Text|no body: ${expected}`);
  return { type: "http", name, method, environment, format, path, query, headers, ...(body === undefined ? {} : { body }) };
}

function parseHttpValueSource(cursor: SentenceCursor): HttpValueSource | undefined {
  if (cursor.takeText("as")) {
    const value = cursor.takeQuoted(() => true);
    return value === undefined ? undefined : { kind: "literal", value };
  }
  if (!cursor.takeText("from")) return undefined;
  if (cursor.takeText("Input")) {
    const input = takeField(cursor);
    return input ? { kind: "input", input } : undefined;
  }
  if (!cursor.takeText("Environment")) return undefined;
  const environment = takeField(cursor);
  return environment ? { kind: "environment", environment } : undefined;
}

function parseCardinality(
  value: string,
  context: CompileContext,
  located: Located,
): "one" | "many" {
  if (!isCardinality(value)) {
    fail(context, "invalid-operation", `Cardinality "${value}" must be one or many`, located);
  }
  return value;
}

function parseDomain(
  value: string,
  type: OperationValueType,
  context: CompileContext,
  located: Located,
): OperationValueDomain {
  if (value === "any") return { kind: "any" };
  if (type !== "string") {
    fail(context, "invalid-operation", `Only string fields may declare an enum domain`, located);
  }
  if (!ENUM_DOMAIN.test(value)) {
    fail(context, "invalid-operation", `Domain "${value}" is invalid`, located);
  }
  const values = [...value.matchAll(ENUM_VALUE)].map((item) => item[1] ?? "");
  if (new Set(values).size !== values.length) {
    fail(context, "invalid-operation", `Domain "${value}" repeats a value`, located);
  }
  return { kind: "enum", values };
}

function compileInputSchema(input: Readonly<Record<string, InputField>>): ObjectSchema {
  return objectSchema(
    Object.fromEntries(
      Object.entries(input).map(([name, field]) => [
        name,
        cardinalitySchema(valueSchema(field.type), field.cardinality),
      ]),
    ),
  );
}

function compileEnvironmentSchema(
  environment: Readonly<Record<string, EnvironmentField>>,
): ObjectSchema {
  return objectSchema(
    Object.fromEntries(
      Object.entries(environment).map(([name, field]) => [
        name,
        field.type === "directory"
          ? { type: "string", format: "trust-directory" }
          : field.type === "url"
            ? { type: "string", format: "trust-url" }
            : { type: "string", format: "trust-string" },
      ]),
    ),
  );
}

function compileProducedSchema(
  producedFields: Readonly<Record<string, ProducedField>>,
): ObjectSchema {
  return objectSchema(
    Object.fromEntries(
      Object.entries(producedFields).map(([name, field]) => {
        const base = valueSchema(field.type);
        const constrained = field.domain.kind === "enum"
          ? { ...base, enum: field.domain.values }
          : base;
        return [name, cardinalitySchema(constrained, field.cardinality)];
      }),
    ),
  );
}

function objectSchema(properties: Readonly<Record<string, ValueSchema>>): ObjectSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function valueSchema(type: OperationValueType): ValueSchema {
  if (type === "number") return { type: "number" };
  if (type === "instant") return { type: "string", format: "date-time" };
  if (type === "reference") return { type: "string", minLength: 1 };
  return { type: "string" };
}

function cardinalitySchema(schema: ValueSchema, cardinality: "one" | "many"): ValueSchema {
  return cardinality === "one" ? schema : { type: "array", items: schema };
}

function validateProduce(
  expression: string,
  steps: readonly OperationStep[],
  input: Readonly<Record<string, InputField>>,
  environment: Readonly<Record<string, EnvironmentField>>,
  producedFields: Readonly<Record<string, ProducedField>>,
  context: CompileContext,
): void {
  let ast: unknown;
  try {
    ast = jsonata(expression).ast();
  } catch (error) {
    fail(
      context,
      "invalid-operation",
      `Produce with JSONata is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  assertClosedJsonata(ast, context, "Produce");

  const object = record(ast);
  const pairs = object?.type === "unary" && object.value === "{" ? object.lhs : undefined;
  if (!Array.isArray(pairs)) {
    fail(context, "invalid-operation", "Produce with JSONata must return one object literal");
  }

  const actualFields: string[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      fail(context, "invalid-operation", "Produce with JSONata must use fixed field names");
    }
    const field = record(pair[0]);
    if (field?.type !== "string" || typeof field.value !== "string") {
      fail(context, "invalid-operation", "Produce with JSONata must use fixed field names");
    }
    actualFields.push(field.value);
  }

  const expectedFields = Object.keys(producedFields);
  if (
    new Set(actualFields).size !== actualFields.length
    || actualFields.length !== expectedFields.length
    || actualFields.some((field) => !Object.hasOwn(producedFields, field))
  ) {
    fail(
      context,
      "invalid-operation",
      `Produce fields must be exactly: ${expectedFields.join(", ")}`,
    );
  }

  validateJsonataPaths("Produce", ast, steps, input, environment, context);
}

function validateJsonataExpression(
  label: string,
  expression: string,
  steps: readonly OperationStep[],
  input: Readonly<Record<string, InputField>>,
  environment: Readonly<Record<string, EnvironmentField>>,
  context: CompileContext,
): void {
  let ast: unknown;
  try {
    ast = jsonata(expression).ast();
  } catch (error) {
    fail(context, "invalid-operation", `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertClosedJsonata(ast, context, label);
  validateJsonataPaths(label, ast, steps, input, environment, context);
}

function validateJsonataPaths(
  label: string,
  ast: unknown,
  steps: readonly OperationStep[],
  input: Readonly<Record<string, InputField>>,
  environment: Readonly<Record<string, EnvironmentField>>,
  context: CompileContext,
): void {
  visitJsonata(ast, (path) => {
    const names = path
      .map((part) => record(part)?.value)
      .filter((value): value is string => typeof value === "string");
    const [root, field, result] = names;

    if (root === STEPS_ROOT) {
      const step = steps.find((candidate) => candidate.name === field);
      if (!field || !step) {
        fail(context, "invalid-operation", `${label} references unknown Operation step "${field ?? ""}"`);
      }
      const allowed = operationLanguage.stepResults[step.type];
      if (!result || !(allowed as readonly string[]).includes(result)) {
        fail(context, "invalid-operation", `${label} references unknown ${step.type} result "${result ?? ""}"`);
      }
      if (step.type === "shell" && names.length > 3) {
        fail(context, "invalid-operation", `${label} cannot traverse Shell result "${result}"`);
      }
      if (step.type === "file-read" && result === "relativePath" && names.length > 3) {
        fail(context, "invalid-operation", `${label} cannot traverse File relativePath`);
      }
      if (step.type === "file-read" && step.file.format === "text" && result === "content" && names.length > 3) {
        fail(context, "invalid-operation", `${label} cannot traverse Text File content`);
      }
      if (step.type === "http" && (result === "status" || result === "headers") && names.length > 3) {
        fail(context, "invalid-operation", `${label} cannot traverse HTTP result "${result}"`);
      }
      if (step.type === "http" && step.http.format !== "json" && result === "body" && names.length > 3) {
        fail(context, "invalid-operation", `${label} cannot traverse non-JSON HTTP body`);
      }
      return;
    }
    if (root === INPUT_ROOT) {
      if (!field || !Object.hasOwn(input, field)) {
        fail(context, "invalid-operation", `${label} references unknown Input field "${field ?? ""}"`);
      }
      if (names.length !== 2) {
        fail(context, "invalid-operation", `${label} cannot traverse Input field "${field}"`);
      }
      return;
    }
    if (root === ENVIRONMENT_ROOT) {
      if (!field || !Object.hasOwn(environment, field)) {
        fail(context, "invalid-operation", `${label} references unknown Environment field "${field ?? ""}"`);
      }
      if (names.length !== 2) {
        fail(context, "invalid-operation", `${label} cannot traverse Environment field "${field}"`);
      }
      return;
    }
    if (root === EXECUTION_ROOT) {
      if (field !== "id" || names.length !== 2) {
        fail(context, "invalid-operation", `${label} references unknown Execution field "${field ?? ""}"`);
      }
      return;
    }
    fail(context, "invalid-operation", `${label} references unknown root "${root ?? ""}"`);
  });
}

function assertClosedJsonata(value: unknown, context: CompileContext, label: string, rootVariable = false): void {
  if (Array.isArray(value)) {
    for (const item of value) assertClosedJsonata(item, context, label, rootVariable);
    return;
  }
  const node = record(value);
  if (!node) return;
  const type = typeof node.type === "string" ? node.type : undefined;
  if (type && !JSONATA_NODE_TYPES.has(type)) {
    fail(context, "invalid-operation", `${label} uses unsupported JSONata form "${type}"`);
  }
  if (type === "variable") {
    const name = typeof node.value === "string" ? node.value : "";
    if (name === "$" && !rootVariable) {
      fail(context, "invalid-operation", `${label} uses the JSONata root only inside a rooted path`);
    }
    if (name !== "$" && !JSONATA_FUNCTIONS.has(name)) {
      fail(context, "invalid-operation", `${label} uses unsupported JSONata function "$${name}"`);
    }
  }
  if (type === "binary") {
    const operator = typeof node.value === "string" ? node.value : "";
    if (!JSONATA_BINARY_OPERATORS.has(operator)) {
      fail(context, "invalid-operation", `${label} uses unsupported JSONata operator "${operator}"`);
    }
  }
  if (type === "unary" && node.value !== "{") {
    fail(context, "invalid-operation", `${label} uses unsupported JSONata unary operator`);
  }
  if (Array.isArray(node.stages) && node.stages.some((stage) => record(stage)?.type !== "filter")) {
    fail(context, "invalid-operation", `${label} allows only fixed JSONata filter path stages`);
  }
  if (type === "path" && Array.isArray(node.steps)) {
    node.steps.forEach((step, index) => assertClosedJsonata(step, context, label, index === 0));
    for (const [key, child] of Object.entries(node)) {
      if (key !== "steps") assertClosedJsonata(child, context, label);
    }
    return;
  }
  for (const child of Object.values(node)) assertClosedJsonata(child, context, label);
}

function assertRelativeFilePath(path: string, context: CompileContext, located: Located): void {
  const segments = path.split("/");
  if (
    path === ""
    || path.includes("\0")
    || path.includes("\\")
    || path.startsWith("/")
    || /^[A-Za-z]:\//.test(path)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(context, "invalid-operation", `File path "${path}" must be a canonical relative path`, located);
  }
}

function visitJsonata(
  value: unknown,
  visitPath: (path: readonly unknown[]) => void,
  relative = false,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visitJsonata(item, visitPath, relative);
    return;
  }
  const node = record(value);
  if (!node) return;
  if (node.type === "path" && Array.isArray(node.steps)) {
    const first = record(node.steps[0]);
    if (first?.type === "variable" && first.value === "$") {
      visitPath(node.steps.slice(1));
    } else if (first?.type === "function") {
      visitJsonata(first.arguments, visitPath, relative);
    } else if (!relative) {
      visitPath(node.steps);
    }
    for (const step of node.steps) {
      const stages = record(step)?.stages;
      if (!Array.isArray(stages)) continue;
      for (const stage of stages) {
        const expression = record(stage)?.expr;
        if (expression !== undefined) visitJsonata(expression, visitPath, true);
      }
    }
    return;
  }
  for (const child of Object.values(node)) visitJsonata(child, visitPath, relative);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertValueType(
  type: OperationValueType,
  label: string,
  name: string,
  context: CompileContext,
  located: Located,
): void {
  if (!VALUE_TYPES.has(type)) {
    fail(context, "invalid-operation", `${label} "${name}" has invalid type "${type}"`, located);
  }
}

function assertFieldName(name: string, label: string, context: CompileContext, located: Located): void {
  if (!FIELD_NAME.test(name)) {
    fail(context, "invalid-identifier", `${label} "${name}" must be lower camel case`, located);
  }
}

/** Free-text block under `Feature:` — the human description. Lines are de-indented, blank runs kept as paragraphs. */
function readDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const indent = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length));
  const text = lines
    .map((line) => (line.trim() === "" ? "" : line.slice(Number.isFinite(indent) ? indent : 0).trimEnd()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? undefined : text;
}

/** An Input rendered into a string position (a Shell argument, a directory narrowing, an HTTP path
    segment or query value) must be one declared Input whose values are strings: `one` cardinality and
    a `string`, `reference` or `instant` type — the types that compile to a string schema. */
function assertStringInput(
  label: string,
  noun: string,
  inputName: string,
  input: Readonly<Record<string, InputField>>,
  context: CompileContext,
  located: Located,
): void {
  const field = Object.hasOwn(input, inputName) ? input[inputName] : undefined;
  if (!field) {
    fail(context, "invalid-operation", `${label} ${noun} references unknown Input "${inputName}"`, located);
  }
  if (field.cardinality !== "one" || field.type === "number") {
    fail(context, "invalid-operation", `${label} ${noun} Input "${inputName}" must be one string`, located);
  }
}

function assertHttpValueSource(
  label: string,
  noun: string,
  source: HttpValueSource,
  input: Readonly<Record<string, InputField>>,
  environment: Readonly<Record<string, EnvironmentField>>,
  context: CompileContext,
  located: Located,
): void {
  if (source.kind === "literal") return;
  if (source.kind === "input") {
    assertStringInput(label, noun, source.input, input, context, located);
    return;
  }
  const field = Object.hasOwn(environment, source.environment) ? environment[source.environment] : undefined;
  if (!field) {
    fail(context, "invalid-operation", `${label} ${noun} references unknown Environment "${source.environment}"`, located);
  }
  if (field.type !== "string") {
    fail(context, "invalid-operation", `${label} ${noun} Environment "${source.environment}" must be a string`, located);
  }
}

function requireTable(step: Step, header: readonly string[], context: CompileContext) {
  const rows = step.dataTable?.rows ?? [];
  const actual = rows[0]?.cells.map((cell) => cell.value.trim()) ?? [];
  if (step.docString || JSON.stringify(actual) !== JSON.stringify(header) || rows.length < 2) {
    fail(context, "invalid-operation", `Table must declare ${header.join(" | ")}`, step);
  }
  return rows.slice(1);
}

function readUniqueTag(
  tags: readonly { readonly name: string }[],
  prefix: string,
  label: string,
  context: CompileContext,
  located: Located,
): string {
  const matches = tags.filter((tag) => tag.name.startsWith(prefix));
  if (matches.length !== 1) {
    fail(context, "invalid-operation", `Operation must declare exactly one ${label} tag`, located);
  }
  return matches[0]?.name.slice(prefix.length) ?? "";
}

/** Free classification tags: `@x-<key>:<value>`, any key, repeatable; opaque to execution. */
function readClassification(
  tags: readonly { readonly name: string }[],
  context: CompileContext,
  located: Located,
): Record<string, readonly string[]> {
  const classification: Record<string, string[]> = {};
  for (const tag of tags) {
    if (!tag.name.startsWith(CLASSIFICATION_TAG)) continue;
    const match = CLASSIFICATION.exec(tag.name);
    if (!match) {
      fail(
        context,
        "invalid-identifier",
        `Classification tag "${tag.name}" must use the @x-<key>:<value> form (lower-case key, value without spaces or colons)`,
        located,
      );
    }
    const key = match[1]!;
    const value = match[2]!;
    const values = classification[key] ?? [];
    if (!values.includes(value)) values.push(value);
    classification[key] = values;
  }
  return classification;
}

function assertOnlyTags(
  tags: readonly { readonly name: string }[],
  allowedPrefixes: readonly string[],
  context: CompileContext,
  located: Located,
): void {
  for (const tag of tags) {
    if (!allowedPrefixes.some((prefix) => tag.name.startsWith(prefix))) {
      fail(context, "invalid-operation", `Tag "${tag.name}" is outside the closed Operation grammar`, located);
    }
  }
}

function assertNoSecretLikeValue(source: string, context: CompileContext): void {
  if (SECRET_LIKE.test(source)) {
    fail(context, "secret-like-value", "Operation source contains a secret-like value");
  }
}

function fail(
  context: CompileContext,
  code: OperationCompilationErrorCode,
  message: string,
  located?: Located,
): never {
  const location = located?.location;
  throw new OperationCompilationError(
    code,
    message,
    context.sourceName,
    location ? { line: location.line, column: location.column ?? 1 } : undefined,
  );
}
