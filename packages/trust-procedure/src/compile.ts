import { createHash } from "node:crypto";

import type { GherkinDocument, Scenario, Step, Tag } from "@cucumber/messages";
import {
  GherkinSyntaxError,
  normalizeGherkinSource,
  parseGherkin,
  tokenizeSentence,
  type SentenceToken,
} from "@trust/gherkin";
import {
  CompiledOperationValidationError,
  validateCompiledOperation,
  type CompiledOperation,
  type ValueSchema,
} from "@trust/operation";
import jsonata from "jsonata";

import {
  CatalogProcedureCompilationError,
  type CompiledProcedure,
  type CompiledProcedureCheck,
  type CompiledProcedureExpectation,
  type CompiledProcedurePredicate,
  type CompiledProcedureRole,
  type ProcedureCompilationErrorCode,
  type ProcedureCompilationInput,
  type ProcedureValueType,
} from "./procedure.js";

const PROCEDURE_TAG = "@procedure:";
const VERSION_TAG = "@version:";
const TRUST_DSL_TAG = "@trust-dsl:";
const SCENARIO_TAG = "@scenario:";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const AGGREGATION = "the Scenario is satisfied when every Check is validated";
const RELATIONS = new Set(["equals", "at least", "has at least", "is in", "before", "after"]);

interface Located {
  readonly location?: { readonly line: number; readonly column?: number };
}

interface RoleSource {
  readonly name: string;
  readonly type: ProcedureValueType;
  readonly cardinality: "one" | "many";
  readonly parents: readonly { readonly role: string; readonly each: boolean }[];
  readonly declared: boolean;
  readonly fixed?: string;
  readonly location?: { readonly line: number; readonly column?: number };
}

interface CheckSource {
  readonly name: string;
  readonly operation: string;
  readonly target: { readonly role: string; readonly selection: "one" | "each" | "all"; readonly input: string };
  readonly using: readonly { readonly role: string; readonly selection: "one" | "all"; readonly input: string }[];
  readonly materializes: readonly { readonly role: string; readonly field: string }[];
  readonly successReason: string;
  readonly predicates: readonly PredicateSource[];
  readonly location?: { readonly line: number; readonly column?: number };
}

interface PredicateSource {
  readonly field: string;
  readonly relation: string;
  readonly expectation: string;
  readonly failureReason: string;
  readonly location?: { readonly line: number; readonly column?: number };
}

interface ScenarioSource {
  readonly slug: string;
  readonly title: string;
  readonly dependencies: readonly string[];
  readonly checks: readonly CheckSource[];
  readonly location?: { readonly line: number; readonly column?: number };
}

export function compileProcedure(input: ProcedureCompilationInput): CompiledProcedure {
  const sourceName = input.sourceName ?? "<procedure>";
  const source = normalizeGherkinSource(input.source);
  let document: GherkinDocument;
  try {
    document = parseGherkin(source);
  } catch (error) {
    if (!(error instanceof GherkinSyntaxError)) throw error;
    throw new CatalogProcedureCompilationError(
      "invalid-procedure",
      `Procedure is not valid Gherkin: ${error.message}`,
      sourceName,
      error.location,
    );
  }
  const feature = document.feature;
  if (!feature || feature.language !== "en") fail("invalid-procedure", "Procedure must contain one English Feature", sourceName);
  if (feature.children.some((child) => child.rule)) fail("invalid-procedure", "Rules are outside the closed Procedure grammar", sourceName, feature);

  const procedure = uniqueTag(feature.tags, PROCEDURE_TAG, "procedure", sourceName, feature);
  const version = uniqueTag(feature.tags, VERSION_TAG, "version", sourceName, feature);
  const dsl = uniqueTag(feature.tags, TRUST_DSL_TAG, "TRUST DSL", sourceName, feature);
  if (!SLUG.test(procedure)) fail("invalid-identifier", `Procedure "${procedure}" must be a lowercase slug`, sourceName, feature);
  if (!SEMVER.test(version)) fail("invalid-identifier", `Version "${version}" must be semantic`, sourceName, feature);
  if (dsl !== "1") fail("invalid-procedure", `TRUST DSL "${dsl}" is unsupported`, sourceName, feature);
  assertOnlyTags(feature.tags, [PROCEDURE_TAG, VERSION_TAG, TRUST_DSL_TAG], sourceName, feature);

  const operationByName = new Map<string, CompiledOperation>();
  for (const operation of input.operations) {
    try {
      validateCompiledOperation(operation);
    } catch (error) {
      const reason = error instanceof CompiledOperationValidationError ? error.message : String(error);
      fail("invalid-procedure", `Supplied Operation is invalid: ${reason}`, sourceName);
    }
    if (operationByName.has(operation.operation)) {
      fail("invalid-procedure", `Operation "${operation.operation}" is supplied more than once`, sourceName);
    }
    operationByName.set(operation.operation, operation);
  }

  const backgrounds = feature.children.flatMap((child) => child.background ? [child.background] : []);
  if (backgrounds.length !== 1 || !backgrounds[0] || backgrounds[0].name !== "Plan context") {
    fail("invalid-procedure", "Procedure must declare exactly one Background named Plan context", sourceName, feature);
  }
  const roleSources = parseRoles(backgrounds[0].steps, sourceName);
  const roleByName = new Map<string, RoleSource>();
  for (const role of roleSources) {
    if (roleByName.has(role.name)) fail("duplicate-role", `Role "${role.name}" is repeated`, sourceName, role);
    roleByName.set(role.name, role);
  }
  validateRoleParents(roleSources, roleByName, sourceName);

  const scenarioNodes = feature.children.flatMap((child) => child.scenario ? [child.scenario] : []);
  if (scenarioNodes.length === 0) fail("invalid-procedure", "Procedure must declare at least one Scenario", sourceName, feature);
  const scenarioSources = scenarioNodes.map((scenario) => parseScenario(scenario, sourceName));
  validateScenarios(scenarioSources, sourceName);

  const checkByName = new Map<string, { readonly check: CheckSource; readonly scenario: ScenarioSource }>();
  for (const scenario of scenarioSources) {
    for (const check of scenario.checks) {
      if (checkByName.has(check.name)) fail("duplicate-check", `Check "${check.name}" is repeated`, sourceName, check);
      checkByName.set(check.name, { check, scenario });
    }
  }

  const operationDigests = new Map<string, string>();
  const materialized = new Map<string, { readonly check: string; readonly field: string }>();
  const compiledChecks: CompiledProcedureCheck[] = [];
  for (const scenario of scenarioSources) {
    for (const check of scenario.checks) {
      const operation = operationByName.get(check.operation);
      if (!operation) fail("unknown-operation", `Check "${check.name}" references unknown Operation "${check.operation}"`, sourceName, check);
      const operationDigest = digest(operationSemantics(operation));
      operationDigests.set(operation.operation, operationDigest);
      const bindings = [check.target, ...check.using];
      const boundInputs = new Set<string>();
      for (const binding of bindings) {
        if (boundInputs.has(binding.input)) fail("input-unbound", `Check "${check.name}" binds Input "${binding.input}" more than once`, sourceName, check);
        boundInputs.add(binding.input);
        const role = roleByName.get(binding.role);
        if (!role) fail("unknown-role", `Check "${check.name}" references unknown role "${binding.role}"`, sourceName, check);
        const schema = operation.input.properties[binding.input];
        if (!schema) fail("unknown-input", `Operation "${operation.operation}" has no Input "${binding.input}"`, sourceName, check);
        assertBinding(
          role,
          binding.selection,
          schema,
          check.name,
          binding.input,
          binding === check.target,
          roleByName.get(check.target.role),
          sourceName,
          check,
        );
      }
      const missing = operation.input.required.filter((name) => !boundInputs.has(name));
      if (missing.length > 0) fail("input-unbound", `Check "${check.name}" does not bind Input: ${missing.join(", ")}`, sourceName, check);
      if ([...boundInputs].some((name) => !operation.input.required.includes(name))) {
        fail("unknown-input", `Check "${check.name}" binds an Input outside the Operation contract`, sourceName, check);
      }

      for (const item of check.materializes) {
        const role = roleByName.get(item.role);
        if (!role) fail("unknown-role", `Check "${check.name}" materializes unknown role "${item.role}"`, sourceName, check);
        if (role.declared || role.fixed !== undefined) fail("invalid-procedure", `Check "${check.name}" cannot materialize declared or fixed role "${item.role}"`, sourceName, check);
        const field = operation.produced.properties[item.field];
        if (!field) fail("unknown-field", `Operation "${operation.operation}" produces no field "${item.field}"`, sourceName, check);
        assertMaterializationShape(
          role,
          field,
          roleByName.get(check.target.role),
          check.target.selection,
          `materialization of role "${item.role}"`,
          sourceName,
          check,
        );
        if (materialized.has(item.role)) fail("invalid-procedure", `Role "${item.role}" has more than one provider`, sourceName, check);
        materialized.set(item.role, { check: check.name, field: item.field });
      }

      const predicates = check.predicates.map((predicate) => compilePredicate(
        predicate,
        operation,
        roleByName,
        checkByName,
        operationByName,
        scenario,
        check,
        scenarioSources,
        sourceName,
      ));
      compiledChecks.push({
        name: check.name,
        scenario: scenario.slug,
        operation: operation.operation,
        operationVersion: operation.version,
        operationDigest,
        target: { role: check.target.role, selection: check.target.selection },
        inputBindings: bindings.map((binding) => ({
          input: binding.input,
          role: binding.role,
          selection: binding.selection,
        })),
        materializes: check.materializes,
        predicates,
        successReason: check.successReason,
      });
    }
  }

  const roles: CompiledProcedureRole[] = roleSources.map((role) => {
    const provider = materialized.get(role.name);
    return {
      name: role.name,
      type: role.type,
      cardinality: role.cardinality,
      parents: role.parents,
      source: role.fixed !== undefined
        ? { kind: "fixed", value: role.fixed }
        : role.declared
          ? { kind: "agent-declaration" }
          : provider
            ? { kind: "operation-field", check: provider.check, field: provider.field }
            : { kind: "plan-input" },
    };
  });
  for (const scenario of scenarioSources) {
    for (const check of scenario.checks) {
      for (const binding of [check.target, ...check.using]) {
        const provider = materialized.get(binding.role);
        if (!provider) continue;
        const providerScenario = checkByName.get(provider.check)?.scenario.slug;
        if (!providerScenario || !isTransitiveDependency(scenario.slug, providerScenario, scenarioSources)) {
          fail(
            "invalid-dependency",
            `Check "${check.name}" uses role "${binding.role}" before its provider Scenario is validated`,
            sourceName,
            check,
          );
        }
      }
      const compiledCheck = compiledChecks.find((candidate) => candidate.name === check.name);
      for (const predicate of compiledCheck?.predicates ?? []) {
        if (predicate.expectation.kind !== "context") continue;
        const provider = materialized.get(predicate.expectation.role);
        if (!provider) continue;
        const providerScenario = checkByName.get(provider.check)?.scenario.slug;
        if (!providerScenario || !isTransitiveDependency(scenario.slug, providerScenario, scenarioSources)) {
          fail(
            "invalid-dependency",
            `Check "${check.name}" compares with role "${predicate.expectation.role}" before its provider Scenario is validated`,
            sourceName,
            check,
          );
        }
      }
    }
  }
  const usedOperationNames = [...operationDigests.keys()].sort();
  const operations = usedOperationNames.map((name) => {
    const definition = operationByName.get(name);
    if (!definition) throw new Error(`Missing compiled Operation ${name}`);
    return { operation: name, version: definition.version, digest: operationDigests.get(name) ?? "", definition };
  });
  const scenarios = scenarioSources.map((scenario) => ({
    slug: scenario.slug,
    title: scenario.title,
    dependencies: scenario.dependencies,
    checks: scenario.checks.map((check) => check.name),
  }));
  const body = { procedure, version, title: feature.name, operations, roles, scenarios, checks: compiledChecks };
  const semanticBody = {
    ...body,
    operations: operations.map(({ definition, ...operation }) => ({
      ...operation,
      definition: operationSemantics(definition),
    })),
  };
  const description = readDescription(feature.description);
  return {
    contract: "trust.compiled-procedure@3",
    ...body,
    ...(description === undefined ? {} : { description }),
    source,
    definitionDigest: digest(semanticBody),
  };
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

function parseRoles(steps: readonly Step[], sourceName: string): RoleSource[] {
  return steps.map((step) => {
    if (step.dataTable || step.docString || (step.keyword.trim() !== "Given" && step.keyword.trim() !== "And")) {
      fail("invalid-procedure", "Plan context accepts only role sentences", sourceName, step);
    }
    const cursor = new TokenCursor(step.text, sourceName, step);
    const cardinality = cursor.takeTextOneOf(["one", "many"]) as "one" | "many";
    const type = cursor.takeTextOneOf(["string", "number", "instant", "reference"]) as ProcedureValueType;
    const name = cursor.takeQuoted();
    let declared = false;
    let fixed: string | undefined;
    const parents: { role: string; each: boolean }[] = [];
    while (!cursor.done()) {
      if (cursor.takeIfText("declared")) {
        cursor.takeText("by");
        cursor.takeText("agent");
        declared = true;
        continue;
      }
      if (cursor.takeIfText("fixed")) {
        cursor.takeText("as");
        fixed = cursor.takeQuoted();
        continue;
      }
      cursor.takeText("for");
      const each = cursor.takeIfText("each");
      parents.push({ role: cursor.takeQuoted(), each });
    }
    if (declared && fixed !== undefined) fail("invalid-procedure", `Role "${name}" cannot be declared and fixed`, sourceName, step);
    if (fixed !== undefined && cardinality !== "one") {
      fail("incompatible-cardinality", `Fixed role "${name}" must have cardinality one`, sourceName, step);
    }
    if (fixed !== undefined && type !== "string" && type !== "reference") {
      fail("incompatible-type", `Fixed role "${name}" must be a string or reference`, sourceName, step);
    }
    return { name, type, cardinality, parents, declared, ...(fixed !== undefined ? { fixed } : {}), location: step.location };
  });
}

function parseScenario(scenario: Scenario, sourceName: string): ScenarioSource {
  if (scenario.keyword !== "Scenario" || scenario.examples.length > 0) fail("invalid-procedure", "Scenario Outline is outside the closed Procedure grammar", sourceName, scenario);
  const slug = uniqueTag(scenario.tags, SCENARIO_TAG, "Scenario", sourceName, scenario);
  assertOnlyTags(scenario.tags, [SCENARIO_TAG], sourceName, scenario);
  if (!SLUG.test(slug)) fail("invalid-identifier", `Scenario "${slug}" must be a lowercase slug`, sourceName, scenario);
  const dependencies: string[] = [];
  const checks: CheckSource[] = [];
  let aggregated = false;
  for (const step of scenario.steps) {
    if (step.text === AGGREGATION) {
      if (aggregated || step.keyword.trim() !== "And" || step.dataTable || step.docString) fail("invalid-procedure", "Scenario aggregation is invalid", sourceName, step);
      aggregated = true;
      continue;
    }
    const dependency = parseDependency(step.text);
    if (dependency) {
      if (checks.length > 0 || aggregated || (step.keyword.trim() !== "Given" && step.keyword.trim() !== "And") || step.dataTable || step.docString) {
        fail("invalid-dependency", "Scenario dependencies must precede Checks", sourceName, step);
      }
      dependencies.push(dependency);
      continue;
    }
    if (aggregated || (step.keyword.trim() !== "Then" && step.keyword.trim() !== "And")) fail("invalid-procedure", "Check placement is invalid", sourceName, step);
    checks.push({ ...parseCheckSentence(step.text, sourceName, step), predicates: parsePredicates(step, sourceName), location: step.location });
  }
  if (!aggregated || checks.length === 0) fail("invalid-procedure", `Scenario "${slug}" must contain Checks and its aggregation`, sourceName, scenario);
  return { slug, title: scenario.name, dependencies, checks, location: scenario.location };
}

function parseDependency(text: string): string | undefined {
  try {
    const tokens = tokenizeSentence(text);
    return tokens.length === 4
      && tokens[0]?.kind === "text" && tokens[0].value === "scenario"
      && tokens[1]?.kind === "quoted"
      && tokens[2]?.kind === "text" && tokens[2].value === "is"
      && tokens[3]?.kind === "text" && tokens[3].value === "validated"
      ? tokens[1].value
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCheckSentence(text: string, sourceName: string, located: Located): Omit<CheckSource, "predicates" | "location"> {
  const cursor = new TokenCursor(text, sourceName, located);
  cursor.takeText("Check");
  const name = cursor.takeQuoted();
  cursor.takeText("runs");
  cursor.takeText("Operation");
  const operation = cursor.takeQuoted();
  cursor.takeText("on");
  const selection = cursor.takeTextOneOfIf(["each", "all"]) as "each" | "all" | undefined;
  const role = cursor.takeQuoted();
  cursor.takeText("as");
  cursor.takeText("Input");
  const input = cursor.takeQuoted();
  const using: { role: string; selection: "one" | "all"; input: string }[] = [];
  const materializes: { role: string; field: string }[] = [];
  let successReason: string | undefined;
  while (!cursor.done()) {
    if (cursor.takeIfText("using")) {
      const useSelection = cursor.takeIfText("all") ? "all" : "one";
      const useRole = cursor.takeQuoted();
      cursor.takeText("as");
      cursor.takeText("Input");
      using.push({ role: useRole, selection: useSelection, input: cursor.takeQuoted() });
      continue;
    }
    cursor.takeText("and");
    if (cursor.takeIfText("materializes")) {
      const materializedRole = cursor.takeQuoted();
      cursor.takeText("from");
      cursor.takeText("field");
      materializes.push({ role: materializedRole, field: cursor.takeQuoted() });
      continue;
    }
    cursor.takeText("must");
    cursor.takeText("establish");
    successReason = cursor.takeQuoted();
    if (!cursor.done()) fail("invalid-procedure", `Check "${name}" has trailing words`, sourceName, located);
  }
  if (!successReason) fail("invalid-procedure", `Check "${name}" must establish one reason`, sourceName, located);
  return {
    name,
    operation,
    target: { role, selection: selection ?? "one", input },
    using,
    materializes,
    successReason,
  };
}

function parsePredicates(step: Step, sourceName: string): PredicateSource[] {
  const rows = step.dataTable?.rows;
  if (!rows || rows.length < 2) fail("invalid-procedure", "Every Check requires a predicate table", sourceName, step);
  const headers = rows[0]?.cells.map((cell) => cell.value.trim()) ?? [];
  const expected = ["field", "relation", "expectation", "failure reason"];
  if (headers.length !== expected.length || headers.some((header, index) => header !== expected[index])) {
    fail("invalid-procedure", `Check table must use: ${expected.join(" | ")}`, sourceName, step);
  }
  return rows.slice(1).map((row) => {
    if (row.cells.length !== 4) fail("invalid-procedure", "Check predicate row must contain four cells", sourceName, row);
    return {
      field: row.cells[0]?.value.trim() ?? "",
      relation: row.cells[1]?.value.trim() ?? "",
      expectation: row.cells[2]?.value.trim() ?? "",
      failureReason: row.cells[3]?.value.trim() ?? "",
      location: row.location,
    };
  });
}

function compilePredicate(
  source: PredicateSource,
  operation: CompiledOperation,
  roles: ReadonlyMap<string, RoleSource>,
  checks: ReadonlyMap<string, { readonly check: CheckSource; readonly scenario: ScenarioSource }>,
  operations: ReadonlyMap<string, CompiledOperation>,
  scenario: ScenarioSource,
  currentCheck: CheckSource,
  scenarios: readonly ScenarioSource[],
  sourceName: string,
): CompiledProcedurePredicate {
  const fieldSchema = operation.produced.properties[source.field];
  if (!fieldSchema) fail("unknown-field", `Operation "${operation.operation}" produces no field "${source.field}"`, sourceName, source);
  if (!RELATIONS.has(source.relation)) fail("invalid-procedure", `Relation "${source.relation}" is unknown`, sourceName, source);
  if (source.failureReason === "") fail("invalid-procedure", "Failure reason cannot be empty", sourceName, source);
  const expectation = parseExpectation(source.expectation, sourceName, source);
  let expectationSchema: ValueSchema;
  if (expectation.kind === "context") {
    const role = roles.get(expectation.role);
    if (!role) fail("unknown-role", `Expectation references unknown role "${expectation.role}"`, sourceName, source);
    const targetRole = roles.get(currentCheck.target.role);
    expectationSchema = currentCheck.target.selection === "each" && role.cardinality === "many"
      && targetRole !== undefined && sameScope(role, targetRole)
      ? baseSchema(schemaForRole(role))
      : schemaForRole(role);
    assertContextShape(
      role,
      fieldSchema,
      targetRole,
      currentCheck.target.selection,
      `expectation for field "${source.field}"`,
      sourceName,
      source,
    );
  } else if (expectation.kind === "check-field") {
    const provider = checks.get(expectation.check);
    if (!provider) fail("invalid-dependency", `Expectation references unknown Check "${expectation.check}"`, sourceName, source);
    const providerOperation = operations.get(provider.check.operation);
    const providerField = providerOperation?.produced.properties[expectation.field];
    if (!providerField) fail("unknown-field", `Check "${expectation.check}" produces no field "${expectation.field}"`, sourceName, source);
    expectationSchema = providerField;
    if (!isTransitiveDependency(scenario.slug, provider.scenario.slug, scenarios)) {
      fail("invalid-dependency", `Check "${expectation.check}" is not in a prerequisite Scenario`, sourceName, source);
    }
    assertSchemasEqual(fieldSchema, providerField, `field "${source.field}" and upstream field "${expectation.field}"`, sourceName, source);
  } else if (expectation.kind === "number") {
    expectationSchema = { type: "number" };
    if (baseSchema(fieldSchema).type !== "number") fail("incompatible-type", `Field "${source.field}" is not a number`, sourceName, source);
  } else if (expectation.kind === "valid-rfc3339") {
    expectationSchema = { type: "string", format: "date-time" };
    const base = baseSchema(fieldSchema);
    if (base.type !== "string" || base.format !== "date-time") fail("incompatible-type", `Field "${source.field}" is not an instant`, sourceName, source);
  } else if (baseSchema(fieldSchema).type !== "string") {
    fail("incompatible-type", `Field "${source.field}" cannot be compared with a string value`, sourceName, source);
  } else {
    expectationSchema = { type: "string" };
    const field = baseSchema(fieldSchema);
    if (field.type === "string" && field.enum && !field.enum.includes(expectation.value)) {
      fail("incompatible-type", `Value "${expectation.value}" is outside field "${source.field}" domain`, sourceName, source);
    }
  }
  assertRelation(source.relation, fieldSchema, expectationSchema, expectation, sourceName, source);
  return {
    field: source.field,
    relation: source.relation as CompiledProcedurePredicate["relation"],
    expectation,
    failureReason: source.failureReason,
  };
}

function parseExpectation(text: string, sourceName: string, located: Located): CompiledProcedureExpectation {
  const cursor = new TokenCursor(text, sourceName, located);
  const kind = cursor.takeTextOneOf(["value", "number", "valid", "context", "field"]);
  if (kind === "value") {
    const value = cursor.takeQuoted();
    cursor.assertDone();
    return { kind: "value", value };
  }
  if (kind === "number") {
    const token = cursor.takeTextValue();
    cursor.assertDone();
    const value = Number(token);
    if (!Number.isFinite(value)) fail("invalid-procedure", `Number expectation "${token}" is invalid`, sourceName, located);
    return { kind: "number", value };
  }
  if (kind === "valid") {
    cursor.takeText("rfc3339");
    cursor.assertDone();
    return { kind: "valid-rfc3339" };
  }
  if (kind === "context") {
    const role = cursor.takeQuoted();
    cursor.assertDone();
    return { kind: "context", role };
  }
  const field = cursor.takeQuoted();
  cursor.takeText("from");
  cursor.takeText("Check");
  const check = cursor.takeQuoted();
  cursor.assertDone();
  return { kind: "check-field", check, field };
}

function validateRoleParents(roles: readonly RoleSource[], byName: ReadonlyMap<string, RoleSource>, sourceName: string): void {
  for (const role of roles) {
    for (const parent of role.parents) {
      if (!byName.has(parent.role)) fail("unknown-role", `Role "${role.name}" has unknown parent "${parent.role}"`, sourceName, role);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) fail("dependency-cycle", `Role parent cycle contains "${name}"`, sourceName, byName.get(name));
    if (visited.has(name)) return;
    visiting.add(name);
    for (const parent of byName.get(name)?.parents ?? []) visit(parent.role);
    visiting.delete(name);
    visited.add(name);
  };
  for (const role of roles) visit(role.name);
}

function validateScenarios(scenarios: readonly ScenarioSource[], sourceName: string): void {
  const bySlug = new Map<string, ScenarioSource>();
  for (const scenario of scenarios) {
    if (bySlug.has(scenario.slug)) fail("duplicate-scenario", `Scenario "${scenario.slug}" is repeated`, sourceName, scenario);
    bySlug.set(scenario.slug, scenario);
  }
  for (const scenario of scenarios) {
    for (const dependency of scenario.dependencies) {
      if (!bySlug.has(dependency)) fail("invalid-dependency", `Scenario "${scenario.slug}" depends on unknown Scenario "${dependency}"`, sourceName, scenario);
      if (dependency === scenario.slug) fail("dependency-cycle", `Scenario "${scenario.slug}" depends on itself`, sourceName, scenario);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (slug: string): void => {
    if (visiting.has(slug)) fail("dependency-cycle", `Scenario dependency cycle contains "${slug}"`, sourceName, bySlug.get(slug));
    if (visited.has(slug)) return;
    visiting.add(slug);
    for (const dependency of bySlug.get(slug)?.dependencies ?? []) visit(dependency);
    visiting.delete(slug);
    visited.add(slug);
  };
  for (const scenario of scenarios) visit(scenario.slug);
}

function assertBinding(
  role: RoleSource,
  selection: "one" | "each" | "all",
  schema: ValueSchema,
  check: string,
  input: string,
  primary: boolean,
  targetRole: RoleSource | undefined,
  sourceName: string,
  located: Located,
): void {
  const inputCardinality = schema.type === "array" ? "many" : "one";
  const suppliedCardinality = selection === "all" ? "many" : "one";
  if (selection === "each" && role.cardinality !== "many") fail("incompatible-cardinality", `Check "${check}" cannot run on each member of one role "${role.name}"`, sourceName, located);
  if (selection === "one" && role.cardinality !== "one" && (primary || !targetRole || !sameScope(role, targetRole))) {
    fail("incompatible-cardinality", `Check "${check}" cannot select one unscoped value of role "${role.name}"`, sourceName, located);
  }
  if (selection === "all" && role.cardinality !== "many") fail("incompatible-cardinality", `Check "${check}" cannot select all values of one role "${role.name}"`, sourceName, located);
  if (inputCardinality !== suppliedCardinality) fail("incompatible-cardinality", `Input "${input}" and role "${role.name}" have incompatible cardinality`, sourceName, located);
  const inputBase = baseSchema(schema);
  if (schemaType(inputBase) !== role.type) fail("incompatible-type", `Input "${input}" and role "${role.name}" have incompatible types`, sourceName, located);
}

function assertMaterializationShape(
  role: RoleSource,
  schema: ValueSchema,
  targetRole: RoleSource | undefined,
  targetSelection: "one" | "each" | "all",
  label: string,
  sourceName: string,
  located: Located,
): void {
  const cardinality = schema.type === "array" ? "many" : "one";
  const expanded = targetSelection === "each" && cardinality === "one" && role.cardinality === "many"
    && targetRole !== undefined && sameScope(role, targetRole);
  if ((!expanded && role.cardinality !== cardinality) || role.type !== schemaType(baseSchema(schema))) {
    fail("incompatible-type", `${label} does not match role type and cardinality`, sourceName, located);
  }
}

function assertContextShape(
  role: RoleSource,
  schema: ValueSchema,
  targetRole: RoleSource | undefined,
  targetSelection: "one" | "each" | "all",
  label: string,
  sourceName: string,
  located: Located,
): void {
  const cardinality = schema.type === "array" ? "many" : "one";
  const scoped = targetSelection === "each" && cardinality === "one" && role.cardinality === "many"
    && targetRole !== undefined && sameScope(role, targetRole);
  if ((!scoped && role.cardinality !== cardinality) || role.type !== schemaType(baseSchema(schema))) {
    fail("incompatible-type", `${label} does not match role type and cardinality`, sourceName, located);
  }
}

function sameScope(left: RoleSource, right: RoleSource): boolean {
  if (left.name === right.name) return true;
  if (left.parents.some((parent) => parent.each && parent.role === right.name)) return true;
  if (right.parents.some((parent) => parent.each && parent.role === left.name)) return true;
  const leftParents = left.parents.map((parent) => `${parent.each ? "each:" : "one:"}${parent.role}`).sort();
  const rightParents = right.parents.map((parent) => `${parent.each ? "each:" : "one:"}${parent.role}`).sort();
  return leftParents.length > 0
    && leftParents.length === rightParents.length
    && leftParents.every((parent, index) => parent === rightParents[index]);
}

function assertSchemasEqual(left: ValueSchema, right: ValueSchema, label: string, sourceName: string, located: Located): void {
  const leftCardinality = left.type === "array" ? "many" : "one";
  const rightCardinality = right.type === "array" ? "many" : "one";
  if (leftCardinality !== rightCardinality || schemaType(baseSchema(left)) !== schemaType(baseSchema(right))) {
    fail("incompatible-type", `${label} have incompatible types`, sourceName, located);
  }
}

function assertRelation(
  relation: string,
  field: ValueSchema,
  expectation: ValueSchema,
  compiledExpectation: CompiledProcedureExpectation,
  sourceName: string,
  located: Located,
): void {
  const fieldMany = field.type === "array";
  const expectationMany = expectation.type === "array";
  const fieldType = schemaType(baseSchema(field));
  const expectationType = schemaType(baseSchema(expectation));
  if (relation === "equals") {
    if (compiledExpectation.kind === "valid-rfc3339") {
      if (fieldMany || fieldType !== "instant") fail("incompatible-type", "valid rfc3339 requires one instant field", sourceName, located);
      return;
    }
    if (fieldMany !== expectationMany || fieldType !== expectationType) {
      fail("incompatible-type", "equals requires the same type and cardinality", sourceName, located);
    }
    return;
  }
  if (relation === "at least") {
    if (fieldMany || expectationMany || fieldType !== "number" || expectationType !== "number") {
      fail("incompatible-type", "at least requires one number field and one number expectation", sourceName, located);
    }
    return;
  }
  if (relation === "has at least") {
    if (!fieldMany || expectationMany || expectationType !== "number") {
      fail("incompatible-type", "has at least requires a collection field and one number expectation", sourceName, located);
    }
    return;
  }
  if (relation === "is in") {
    if (fieldMany || !expectationMany || fieldType !== expectationType) {
      fail("incompatible-type", "is in requires one field and a collection expectation of the same type", sourceName, located);
    }
    return;
  }
  if (fieldMany || expectationMany || fieldType !== "instant" || expectationType !== "instant") {
    fail("incompatible-type", `${relation} requires one instant field and one instant expectation`, sourceName, located);
  }
}

function schemaForRole(role: RoleSource): ValueSchema {
  const base: ValueSchema = role.type === "number"
    ? { type: "number" }
    : role.type === "instant"
      ? { type: "string", format: "date-time" }
      : role.type === "reference"
        ? { type: "string", minLength: 1 }
        : { type: "string" };
  return role.cardinality === "many" ? { type: "array", items: base } : base;
}

function baseSchema(schema: ValueSchema): Exclude<ValueSchema, { readonly type: "array" }> {
  return schema.type === "array" ? baseSchema(schema.items) : schema;
}

function schemaType(schema: Exclude<ValueSchema, { readonly type: "array" }>): ProcedureValueType {
  if (schema.type === "number") return "number";
  if (schema.format === "date-time") return "instant";
  if (schema.minLength === 1) return "reference";
  return "string";
}

function isTransitiveDependency(current: string, expected: string, scenarios: readonly ScenarioSource[]): boolean {
  const bySlug = new Map(scenarios.map((scenario) => [scenario.slug, scenario]));
  const pending = [...(bySlug.get(current)?.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const slug = pending.pop();
    if (!slug || visited.has(slug)) continue;
    if (slug === expected) return true;
    visited.add(slug);
    pending.push(...(bySlug.get(slug)?.dependencies ?? []));
  }
  return false;
}

function operationSemantics(operation: CompiledOperation): unknown {
  const { source: _source, ...semantics } = operation;
  return {
    ...semantics,
    produce: {
      ...semantics.produce,
      expression: jsonataSemantics(semantics.produce.expression),
    },
  };
}

function jsonataSemantics(expression: string): unknown {
  return removeJsonataPositions(jsonata(expression).ast());
}

function removeJsonataPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeJsonataPositions);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "position")
        .map(([key, item]) => [key, removeJsonataPositions(item)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareText(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueTag(tags: readonly Tag[], prefix: string, label: string, sourceName: string, located: Located): string {
  const matches = tags.filter((tag) => tag.name.startsWith(prefix));
  if (matches.length !== 1) fail("invalid-procedure", `${label} tag must appear exactly once`, sourceName, located);
  const value = matches[0]?.name.slice(prefix.length) ?? "";
  if (value === "") fail("invalid-procedure", `${label} tag cannot be empty`, sourceName, located);
  return value;
}

function assertOnlyTags(tags: readonly Tag[], prefixes: readonly string[], sourceName: string, located: Located): void {
  const unknown = tags.find((tag) => !prefixes.some((prefix) => tag.name.startsWith(prefix)));
  if (unknown) fail("invalid-procedure", `Unknown tag "${unknown.name}"`, sourceName, unknown);
}

function fail(code: ProcedureCompilationErrorCode, message: string, sourceName: string, located?: Located): never {
  throw new CatalogProcedureCompilationError(
    code,
    message,
    sourceName,
    located?.location ? { line: located.location.line, column: located.location.column ?? 1 } : undefined,
  );
}

class TokenCursor {
  readonly #tokens: readonly SentenceToken[];
  #index = 0;

  constructor(text: string, readonly sourceName: string, readonly located: Located) {
    try {
      this.#tokens = tokenizeSentence(text);
    } catch {
      fail("invalid-procedure", `Invalid sentence "${text}"`, sourceName, located);
    }
  }

  done(): boolean { return this.#index >= this.#tokens.length; }

  assertDone(): void {
    if (!this.done()) fail("invalid-procedure", "Sentence has trailing words", this.sourceName, this.located);
  }

  takeText(value: string): void {
    const token = this.#tokens[this.#index];
    if (token?.kind !== "text" || token.value !== value) fail("invalid-procedure", `Expected ${value}`, this.sourceName, this.located);
    this.#index += 1;
  }

  takeIfText(value: string): boolean {
    const token = this.#tokens[this.#index];
    if (token?.kind !== "text" || token.value !== value) return false;
    this.#index += 1;
    return true;
  }

  takeTextOneOf(values: readonly string[]): string {
    const value = this.takeTextOneOfIf(values);
    if (!value) fail("invalid-procedure", `Expected one of: ${values.join(", ")}`, this.sourceName, this.located);
    return value;
  }

  takeTextOneOfIf(values: readonly string[]): string | undefined {
    const token = this.#tokens[this.#index];
    if (token?.kind !== "text" || !values.includes(token.value)) return undefined;
    this.#index += 1;
    return token.value;
  }

  takeTextValue(): string {
    const token = this.#tokens[this.#index];
    if (token?.kind !== "text") fail("invalid-procedure", "Expected an unquoted value", this.sourceName, this.located);
    this.#index += 1;
    return token.value;
  }

  takeQuoted(): string {
    const token = this.#tokens[this.#index];
    if (token?.kind !== "quoted" || token.value === "") fail("invalid-procedure", "Expected a quoted value", this.sourceName, this.located);
    this.#index += 1;
    return token.value;
  }
}
