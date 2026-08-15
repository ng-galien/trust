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
  tokenizeSentence,
  type Located,
  type SentenceToken,
} from "@trust/gherkin";
import jsonata from "jsonata";

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

const OPERATION_TAG = "@operation:";
const VERSION_TAG = "@version:";
const TRUST_DSL_TAG = "@trust-dsl:";
const TRUST_DSL_VERSION = "1";
const OPERATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;
const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SECRET_LIKE = /(?:^|[^a-z0-9])(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{8,}|bearer\s+[a-z0-9._-]{8,})/i;
const ENUM_DOMAIN = /^enum "[^"]+"(?:, "[^"]+")*$/;
const ENUM_VALUE = /"([^"]+)"/g;
const VALUE_TYPES = new Set<OperationValueType>([
  "string",
  "number",
  "instant",
  "reference",
]);
const JSONATA_NODE_TYPES = new Set([
  "binary",
  "block",
  "condition",
  "function",
  "name",
  "number",
  "path",
  "string",
  "unary",
  "value",
  "variable",
]);
const JSONATA_FUNCTIONS = new Set([
  "boolean",
  "count",
  "exists",
  "lowercase",
  "number",
  "string",
  "trim",
  "uppercase",
]);
const JSONATA_BINARY_OPERATORS = new Set([
  "!=",
  "%",
  "&",
  "*",
  "+",
  "-",
  "/",
  "<",
  "<=",
  "=",
  ">",
  ">=",
  "and",
  "or",
]);

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
  assertOnlyTags(feature.tags, [OPERATION_TAG, VERSION_TAG, TRUST_DSL_TAG], context, feature);

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
    source,
    input: compileInputSchema(operationInterface.input),
    environment: compileEnvironmentSchema(operationInterface.environment),
    steps: run.steps,
    produce: { language: "jsonata", expression: run.expression },
    produced: compileProducedSchema(operationInterface.producedFields),
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
      if (step.text === "Environment") {
        for (const row of rows) {
          const nameCell = row.cells[0];
          const name = nameCell?.value.trim() ?? "";
          const type = row.cells[1]?.value.trim();
          if (!nameCell || (type !== "directory" && type !== "url")) continue;
          environment.push({
            name,
            type,
            range: sourceLineRange(context.source, row.location),
            selectionRange: sourceValueRange(context.source, nameCell, name),
          });
        }
        continue;
      }
      if (step.text === "Input") {
        for (const row of rows) {
          const nameCell = row.cells[0];
          const name = nameCell?.value.trim() ?? "";
          const type = row.cells[1]?.value.trim();
          const cardinality = row.cells[2]?.value.trim();
          if (!nameCell || !isOperationValueType(type)
            || (cardinality !== "one" && cardinality !== "many")) continue;
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
      if (step.text === "Produced fields") {
        for (const row of rows) {
          const nameCell = row.cells[0];
          const name = nameCell?.value.trim() ?? "";
          const type = row.cells[1]?.value.trim();
          const cardinality = row.cells[2]?.value.trim();
          const domain = isOperationValueType(type)
            ? readSourceDomain(row.cells[3]?.value.trim() ?? "", type)
            : undefined;
          if (!nameCell || !isOperationValueType(type) || !domain
            || (cardinality !== "one" && cardinality !== "many")) continue;
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
      if (!parsed || parsed.type === "shell-exits") continue;
      steps.push({
        name: parsed.name,
        type: parsed.type === "http-post" ? "http" : parsed.type,
        range: sourceLineRange(context.source, step.location),
        selectionRange: sourceValueRange(context.source, step, parsed.name),
      });
    }
  }

  return {
    kind: "operation",
    ...(operationTag ? { operation: operationTag.name.slice(OPERATION_TAG.length) } : {}),
    ...(versionTag ? { version: versionTag.name.slice(VERSION_TAG.length) } : {}),
    title: feature.name,
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
    if (step.text === "Environment") {
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
        if (type !== "directory" && type !== "url") {
          fail(context, "invalid-operation", `Environment "${name}" has invalid type "${type}"`, row);
        }
        environment.set(name, { type });
      }
      continue;
    }
    if (step.text === "Input") {
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
    if (step.text === "Produced fields") {
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
      const { name, executable, environment: environmentName } = parsed;
      if (names.has(name)) fail(context, "duplicate-step", `Step "${name}" is repeated`, step);
      if (!Object.hasOwn(environment, environmentName)) {
        fail(
          context,
          "unknown-environment",
          `Shell "${name}" uses undeclared Environment "${environmentName}"`,
          step,
        );
      }
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
        const sourceTokens = tokenizeSentence(source);
        const inputName = sourceTokens.length === 2
          && sourceTokens[0]?.kind === "text" && sourceTokens[0].value === "Input"
          && sourceTokens[1]?.kind === "quoted"
          ? sourceTokens[1].value
          : undefined;
        if (!inputName || !Object.hasOwn(input, inputName)) {
          fail(context, "invalid-operation", `Shell "${name}" argument references unknown Input "${inputName ?? source}"`, row);
        }
        const schema = compileInputSchema(input).properties[inputName];
        if (!schema || schema.type !== "string") {
          fail(context, "invalid-operation", `Shell "${name}" argument Input "${inputName}" must be one string`, row);
        }
        return { kind: "input" as const, input: inputName };
      });
      names.add(name);
      compiled.push({
        name,
        type: "shell",
        shell: {
          executable,
          arguments: arguments_,
          cwd: { environment: environmentName },
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
      const { name, path, format, environment: environmentName } = parsed;
      if (names.has(name)) fail(context, "duplicate-step", `Step "${name}" is repeated`, step);
      if (!Object.hasOwn(environment, environmentName)) {
        fail(
          context,
          "unknown-environment",
          `File "${name}" uses undeclared Environment "${environmentName}"`,
          step,
        );
      }
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
          root: { environment: environmentName },
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
      if (step.dataTable || step.docString) {
        fail(context, "unknown-step", "HTTP does not accept a table or DocString", step);
      }
      const { name, environment: environmentName, format, appendInput } = parsed;
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
      if (appendInput) {
        const schema = compileInputSchema(input).properties[appendInput];
        if (!schema || schema.type !== "string") {
          fail(context, "invalid-operation", `HTTP "${name}" path Input "${appendInput}" must be one string`, step);
        }
      }
      names.add(name);
      compiled.push({
        name,
        type: "http",
        http: {
          method: "GET",
          url: { environment: environmentName },
          ...(appendInput ? { appendInput } : {}),
          format,
        },
      });
      continue;
    }

    if (parsed?.type === "http-post") {
      const keyword = step.keyword.trim();
      if (keyword !== "When" && keyword !== "And") {
        fail(context, "unknown-step", "HTTP must use When or And", step);
      }
      if (expression !== undefined || step.dataTable || step.docString) {
        fail(context, "unknown-step", "HTTP POST must precede Produce and accepts no table or DocString", step);
      }
      const { name, environment: environmentName } = parsed;
      if (names.has(name)) fail(context, "duplicate-step", `Step "${name}" is repeated`, step);
      if (!Object.hasOwn(environment, environmentName)) {
        fail(context, "unknown-environment", `HTTP "${name}" uses undeclared Environment "${environmentName}"`, step);
      }
      if (environment[environmentName]?.type !== "url") {
        fail(context, "invalid-operation", `HTTP "${name}" requires Environment "${environmentName}" to be a url`, step);
      }
      if (Object.keys(input).length === 0) {
        fail(context, "invalid-operation", `HTTP "${name}" cannot post an empty Input`, step);
      }
      names.add(name);
      compiled.push({
        name,
        type: "http",
        http: {
          method: "POST",
          url: { environment: environmentName },
          body: "input-json",
          format: "json",
        },
      });
      continue;
    }

    if (step.text === "Produce with JSONata") {
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
    }
  | {
      readonly type: "http";
      readonly name: string;
      readonly format: "text" | "json";
      readonly environment: string;
      readonly appendInput?: string;
    }
  | {
      readonly type: "http-post";
      readonly name: string;
      readonly environment: string;
    };

function parseRunStepSentence(source: string): ParsedRunStepSentence | undefined {
  let tokens: readonly SentenceToken[];
  try {
    tokens = tokenizeSentence(source);
  } catch {
    return undefined;
  }
  const text = (index: number, value: string): boolean =>
    tokens[index]?.kind === "text" && tokens[index]?.value === value;
  const quoted = (index: number): string | undefined => {
    const token = tokens[index];
    return token?.kind === "quoted" && token.value.length > 0 ? token.value : undefined;
  };
  const field = (index: number): string | undefined => {
    const value = quoted(index);
    return value && FIELD_NAME.test(value) ? value : undefined;
  };
  const format = (index: number): "text" | "json" | undefined => {
    const token = tokens[index];
    if (token?.kind !== "text" || (token.value !== "Text" && token.value !== "JSON")) {
      return undefined;
    }
    return token.value.toLowerCase() as "text" | "json";
  };

  const shellName = field(1);
  const executable = quoted(3);
  const shellEnvironment = field(8);
  if (tokens.length === 9 && text(0, "Shell") && shellName && text(2, "runs")
    && executable && text(4, "with") && text(5, "cwd") && text(6, "from")
    && text(7, "Environment") && shellEnvironment) {
    return {
      type: "shell",
      name: shellName,
      executable,
      environment: shellEnvironment,
    };
  }

  if (tokens.length === 4 && text(0, "Shell") && shellName && text(2, "accepts")
    && text(3, "exits")) {
    return { type: "shell-exits", name: shellName };
  }

  const fileName = field(1);
  const path = quoted(3);
  const fileFormat = format(5);
  const fileEnvironment = field(8);
  if (tokens.length === 9 && text(0, "File") && fileName && text(2, "reads") && path
    && text(4, "as") && fileFormat && text(6, "from") && text(7, "Environment")
    && fileEnvironment) {
    return {
      type: "file-read",
      name: fileName,
      path,
      format: fileFormat,
      environment: fileEnvironment,
    };
  }

  const httpName = field(1);
  const httpEnvironment = field(4);
  const httpFormat = format(6);
  if (tokens.length === 7 && text(0, "HTTP") && httpName && text(2, "gets")
    && text(3, "Environment") && httpEnvironment && text(5, "as") && httpFormat) {
    return {
      type: "http",
      name: httpName,
      environment: httpEnvironment,
      format: httpFormat,
    };
  }
  const httpAppendInput = field(7);
  const appendedHttpFormat = format(9);
  if (tokens.length === 10 && text(0, "HTTP") && httpName && text(2, "gets")
    && text(3, "Environment") && httpEnvironment && text(5, "appending")
    && text(6, "Input") && httpAppendInput && text(8, "as") && appendedHttpFormat) {
    return {
      type: "http",
      name: httpName,
      environment: httpEnvironment,
      appendInput: httpAppendInput,
      format: appendedHttpFormat,
    };
  }
  const postEnvironment = field(8);
  if (tokens.length === 12 && text(0, "HTTP") && httpName && text(2, "posts")
    && text(3, "Input") && text(4, "as") && text(5, "JSON") && text(6, "to")
    && text(7, "Environment") && postEnvironment && text(9, "and")
    && text(10, "reads") && text(11, "JSON")) {
    return { type: "http-post", name: httpName, environment: postEnvironment };
  }
  return undefined;
}

function parseCardinality(
  value: string,
  context: CompileContext,
  located: Located,
): "one" | "many" {
  if (value !== "one" && value !== "many") {
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
          : { type: "string", format: "trust-url" },
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

  assertClosedJsonata(ast, context);

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

  visitJsonata(ast, (path) => {
    const names = path
      .map((part) => record(part)?.value)
      .filter((value): value is string => typeof value === "string");
    const [root, field, result] = names;

    if (root === "steps") {
      const step = steps.find((candidate) => candidate.name === field);
      if (!field || !step) {
        fail(context, "invalid-operation", `Produce references unknown Operation step "${field ?? ""}"`);
      }
      const allowed = step.type === "shell"
        ? ["exitCode", "stdout", "stderr"]
        : step.type === "file-read"
          ? ["relativePath", "content"]
          : ["status", "headers", "body"];
      if (!result || !allowed.includes(result)) {
        fail(context, "invalid-operation", `Produce references unknown ${step.type} result "${result ?? ""}"`);
      }
      if (step.type === "shell" && names.length > 3) {
        fail(context, "invalid-operation", `Produce cannot traverse Shell result "${result}"`);
      }
      if (step.type === "file-read" && result === "relativePath" && names.length > 3) {
        fail(context, "invalid-operation", `Produce cannot traverse File relativePath`);
      }
      if (step.type === "file-read" && step.file.format === "text" && result === "content" && names.length > 3) {
        fail(context, "invalid-operation", `Produce cannot traverse Text File content`);
      }
      if (step.type === "http" && (result === "status" || result === "headers") && names.length > 3) {
        fail(context, "invalid-operation", `Produce cannot traverse HTTP result "${result}"`);
      }
      if (step.type === "http" && step.http.format === "text" && result === "body" && names.length > 3) {
        fail(context, "invalid-operation", `Produce cannot traverse Text HTTP body`);
      }
      return;
    }
    if (root === "input") {
      if (!field || !Object.hasOwn(input, field)) {
        fail(context, "invalid-operation", `Produce references unknown Input field "${field ?? ""}"`);
      }
      if (names.length !== 2) {
        fail(context, "invalid-operation", `Produce cannot traverse Input field "${field}"`);
      }
      return;
    }
    if (root === "environment") {
      if (!field || !Object.hasOwn(environment, field)) {
        fail(context, "invalid-operation", `Produce references unknown Environment field "${field ?? ""}"`);
      }
      if (names.length !== 2) {
        fail(context, "invalid-operation", `Produce cannot traverse Environment field "${field}"`);
      }
      return;
    }
    fail(context, "invalid-operation", `Produce references unknown root "${root ?? ""}"`);
  });
}

function assertClosedJsonata(value: unknown, context: CompileContext): void {
  if (Array.isArray(value)) {
    for (const item of value) assertClosedJsonata(item, context);
    return;
  }
  const node = record(value);
  if (!node) return;
  const type = typeof node.type === "string" ? node.type : undefined;
  if (type && !JSONATA_NODE_TYPES.has(type)) {
    fail(context, "invalid-operation", `Produce uses unsupported JSONata form "${type}"`);
  }
  if (type === "variable") {
    const name = typeof node.value === "string" ? node.value : "";
    if (!JSONATA_FUNCTIONS.has(name)) {
      fail(context, "invalid-operation", `Produce uses unsupported JSONata function "$${name}"`);
    }
  }
  if (type === "binary") {
    const operator = typeof node.value === "string" ? node.value : "";
    if (!JSONATA_BINARY_OPERATORS.has(operator)) {
      fail(context, "invalid-operation", `Produce uses unsupported JSONata operator "${operator}"`);
    }
  }
  if (type === "unary" && node.value !== "{") {
    fail(context, "invalid-operation", `Produce uses unsupported JSONata unary operator`);
  }
  if (Array.isArray(node.stages) && node.stages.length > 0) {
    fail(context, "invalid-operation", "Produce does not allow dynamic JSONata path stages");
  }
  for (const child of Object.values(node)) assertClosedJsonata(child, context);
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

function visitJsonata(value: unknown, visitPath: (path: readonly unknown[]) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitJsonata(item, visitPath);
    return;
  }
  const node = record(value);
  if (!node) return;
  if (node.type === "path" && Array.isArray(node.steps)) {
    visitPath(node.steps);
    return;
  }
  for (const child of Object.values(node)) visitJsonata(child, visitPath);
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
