import { createHash } from "node:crypto";

import type { GherkinDocument, Scenario, Step, Tag } from "@cucumber/messages";
import {
  GherkinSyntaxError,
  hasGherkinTag,
  normalizeGherkinSource,
  parseGherkin,
  parseStepGrammar,
  tokenizeSentence,
  type StepGrammarMatch,
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
  type CompiledProcedureRole,
  type CompiledProcedureScope,
  type ProcedureCompilationErrorCode,
  type ProcedureCompilationInput,
  type ProcedureAnalysis,
  type ProcedureValueType,
} from "./procedure.js";
import {
  compileQualificationExpression,
  QualificationExpressionError,
} from "./expression.js";
import { transitiveScenarioDependencies } from "./dependencies.js";
import { procedureLanguage, procedureStepGrammar } from "./language.js";

const PROCEDURE_TAG = procedureLanguage.tags.procedure;
const VERSION_TAG = procedureLanguage.tags.version;
const TRUST_DSL_TAG = procedureLanguage.tags.dsl;
const INTENT_CHAINING_TAG = procedureLanguage.tags.intentChaining;
const SCENARIO_TAG = procedureLanguage.tags.scenario;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
/** Reserved role: the Plan identifier, synthesised when a Check uses `using plan as Input`. */
const PLAN_ROLE = "plan";

interface Located {
  readonly location?: { readonly line: number; readonly column?: number };
}

interface RoleSource {
  readonly name: string;
  readonly type: ProcedureValueType;
  readonly cardinality: "one" | "many";
  readonly optional: boolean;
  readonly parents: readonly { readonly role: string; readonly each: boolean }[];
  readonly declared: boolean;
  readonly fixed?: string;
  readonly planIdentifier?: true;
  readonly location?: { readonly line: number; readonly column?: number };
}

interface UsingSource {
  readonly role: string;
  readonly selection: "one" | "all";
  readonly input: string;
}

const PLAN_ROLE_SOURCE: RoleSource = {
  name: PLAN_ROLE,
  type: "string",
  cardinality: "one",
  optional: false,
  parents: [],
  declared: false,
  planIdentifier: true,
};

interface CheckSource {
  readonly name: string;
  readonly operation: string;
  readonly target: { readonly role: string; readonly selection: "one" | "each" | "all"; readonly input: string };
  readonly using: readonly UsingSource[];
  readonly materializes: readonly { readonly role: string; readonly field: string }[];
  readonly successReason: string;
  readonly qualification: QualificationSource;
  readonly location?: { readonly line: number; readonly column?: number };
}

interface QualificationSource {
  readonly source: string;
  readonly location: { readonly line: number; readonly column: number };
}

interface ScenarioSource {
  readonly slug: string;
  readonly title: string;
  readonly dependencies: readonly string[];
  readonly checks: readonly CheckSource[];
  readonly location?: { readonly line: number; readonly column?: number };
}

interface PlanContextSource {
  readonly roles: RoleSource[];
  readonly scope: CompiledProcedureScope[];
}

export function compileProcedure(input: ProcedureCompilationInput): CompiledProcedure {
  return compileProcedureInternal(input);
}

export function analyzeProcedure(input: ProcedureCompilationInput): ProcedureAnalysis {
  const diagnostics: ProcedureAnalysis["diagnostics"][number][] = [];
  try {
    const compiled = compileProcedureInternal(input, (error, qualification) => diagnostics.push({
      code: error.code,
      message: error.message,
      sourceName: input.sourceName ?? "<procedure>",
      location: qualification.location,
    }));
    return { compiled, diagnostics };
  } catch (error) {
    if (!(error instanceof CatalogProcedureCompilationError)) throw error;
    diagnostics.push({ code: error.code, message: error.message, sourceName: error.sourceName ?? "<procedure>", ...(error.location ? { location: error.location } : {}) });
    return { diagnostics };
  }
}

function compileProcedureInternal(
  input: ProcedureCompilationInput,
  reportQualificationError?: (error: QualificationExpressionError, qualification: QualificationSource) => void,
): CompiledProcedure {
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
  const intentChainingTags = feature.tags.filter((tag) => tag.name === INTENT_CHAINING_TAG);
  if (intentChainingTags.length > 1) {
    fail("invalid-procedure", "Intent chaining tag must appear at most once", sourceName, intentChainingTags[1]);
  }
  const intentChaining = intentChainingTags.length === 1;
  if (!SLUG.test(procedure)) fail("invalid-identifier", `Procedure "${procedure}" must be a lowercase slug`, sourceName, feature);
  if (!SEMVER.test(version)) fail("invalid-identifier", `Version "${version}" must be semantic`, sourceName, feature);
  if (dsl !== procedureLanguage.dslVersion) fail("invalid-procedure", `TRUST DSL "${dsl}" is unsupported`, sourceName, feature);
  assertOnlyTags(feature.tags, [PROCEDURE_TAG, VERSION_TAG, TRUST_DSL_TAG, INTENT_CHAINING_TAG], sourceName, feature);

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
  if (backgrounds.length !== 1 || !backgrounds[0] || backgrounds[0].name !== procedureLanguage.phrases.context) {
    fail("invalid-procedure", "Procedure must declare exactly one Background named Plan context", sourceName, feature);
  }
  const planContext = parsePlanContext(backgrounds[0].steps, sourceName);
  const roleSources = planContext.roles;
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
  if (scenarioSources.some((scenario) => scenario.checks.some((check) => check.using.some((use) => use.role === PLAN_ROLE)))) {
    roleSources.push(PLAN_ROLE_SOURCE);
    roleByName.set(PLAN_ROLE, PLAN_ROLE_SOURCE);
  }

  const checkByName = new Map<string, { readonly check: CheckSource; readonly scenario: ScenarioSource }>();
  for (const scenario of scenarioSources) {
    for (const check of scenario.checks) {
      if (check.name === "all") {
        fail("invalid-procedure", "Check name \"all\" is reserved for the global Procedure scope", sourceName, check);
      }
      if (checkByName.has(check.name)) fail("duplicate-check", `Check "${check.name}" is repeated`, sourceName, check);
      checkByName.set(check.name, { check, scenario });
    }
  }
  validateProcedureScope(planContext.scope, checkByName, sourceName);

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
          // The Plan identifier is a slug: it satisfies a reference Input as well as a string one.
          role.planIdentifier && schemaType(baseSchema(schema)) === "reference" ? { ...role, type: "reference" } : role,
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
        if (role.declared || role.fixed !== undefined || role.planIdentifier) fail("invalid-procedure", `Check "${check.name}" cannot materialize declared or fixed role "${item.role}"`, sourceName, check);
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

      const expressionInput = {
        operation,
        contextRoles: new Map([...roleByName].map(([name, role]) => {
          const targetRole = roleByName.get(check.target.role);
          const schema = check.target.selection === "each" && role.cardinality === "many"
            && targetRole !== undefined && sameScope(role, targetRole)
            ? baseSchema(schemaForRole(role))
            : schemaForRole(role);
          return [name, schema];
        })),
        checks: new Map(
          [...checkByName].flatMap(([name, provider]) => {
            const providerOperation = operationByName.get(provider.check.operation);
            return providerOperation ? [[name, { operation: providerOperation, scenario: provider.scenario.slug }] as const] : [];
          }),
        ),
        canReferenceCheck: (providerScenario: string) => isTransitiveDependency(scenario.slug, providerScenario, scenarioSources),
      };
      let guards;
      try {
        guards = compileQualificationExpression({
          source: check.qualification.source,
          ...expressionInput,
        });
      } catch (error) {
        if (!(error instanceof QualificationExpressionError)) throw error;
        if (!reportQualificationError) fail(error.code, error.message, sourceName, check.qualification);
        reportQualificationError(error, check.qualification);
        guards = compileQualificationExpression({ source: 'true || fail("invalid qualification")', ...expressionInput });
      }
      compiledChecks.push({
        name: check.name,
        scenario: scenario.slug,
        operation: operation.operation,
        operationVersion: operation.version,
        operationDigest,
        target: { role: check.target.role, selection: check.target.selection },
        inputBindings: bindings.map((binding) => ({ input: binding.input, role: binding.role, selection: binding.selection })),
        materializes: check.materializes,
        qualification: {
          source: check.qualification.source,
          guards,
          location: check.qualification.location,
        },
        successReason: check.successReason,
        ...(check.location ? { location: check.location } : {}),
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
      source: role.planIdentifier
        ? { kind: "plan-identifier" }
        : role.fixed !== undefined
          ? { kind: "fixed", value: role.fixed }
          : role.declared
            ? { kind: "agent-declaration", ...(role.optional ? { optional: true as const } : {}) }
            : provider
              ? { kind: "operation-field", check: provider.check, field: provider.field }
              : { kind: "plan-input" },
      ...(role.location ? { location: role.location } : {}),
    };
  });
  validateOptionalRoleDependencies(roles, roleByName, sourceName);
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
      for (const reference of compiledCheck?.qualification.guards.flatMap((guard) => guard.references) ?? []) {
        if (reference.kind !== "context") continue;
        const provider = materialized.get(reference.role);
        if (!provider) continue;
        const providerScenario = checkByName.get(provider.check)?.scenario.slug;
        if (!providerScenario || !isTransitiveDependency(scenario.slug, providerScenario, scenarioSources)) {
          fail(
            "invalid-dependency",
            `Check "${check.name}" reads role "${reference.role}" before its provider Scenario is validated`,
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
    ...(scenario.location ? { location: scenario.location } : {}),
  }));
  const body = { procedure, version, title: feature.name, intentChaining, operations, scope: planContext.scope, roles, scenarios, checks: compiledChecks };
  const semanticBody = {
    ...body,
    operations: operations.map(({ definition, ...operation }) => ({
      ...operation,
      definition: operationSemantics(definition),
    })),
    roles: roles.map(({ location: _location, ...role }) => role),
    scope: planContext.scope.map(({ location: _location, ...scope }) => scope),
    scenarios: scenarios.map(({ location: _location, ...scenario }) => scenario),
    checks: compiledChecks.map(({ location: _location, ...check }) => ({
      ...check,
      qualification: { guards: check.qualification.guards },
    })),
  };
  const description = readDescription(feature.description);
  return {
    ...body,
    ...(description === undefined ? {} : { description }),
    source,
    definitionDigest: digest(semanticBody),
  };
}

export function isProcedureSource(source: string): boolean {
  const normalized = normalizeGherkinSource(source);
  try {
    return parseGherkin(normalized).feature?.tags.some((tag) => tag.name.startsWith(PROCEDURE_TAG)) ?? false;
  } catch (error) {
    if (error instanceof GherkinSyntaxError) return hasGherkinTag(source, PROCEDURE_TAG);
    throw error;
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

function parsePlanContext(steps: readonly Step[], sourceName: string): PlanContextSource {
  const [scopeStep, ...roleSteps] = steps;
  const parsedScope = scopeStep ? parseProcedureStep(scopeStep.text, "background") : undefined;
  if (!scopeStep || scopeStep.keyword.trim() !== "Given" || parsedScope?.production !== "scope"
    || !scopeStep.dataTable || scopeStep.docString) {
    fail("invalid-procedure", "Plan context must start with one Procedure scope DataTable", sourceName, scopeStep);
  }
  const rows = scopeStep.dataTable.rows;
  const header = rows[0]?.cells.map((cell) => cell.value.trim());
  if (header?.length !== 3 || header[0] !== "check" || header[1] !== "authorized" || header[2] !== "forbidden") {
    fail("invalid-procedure", "Procedure scope columns must be check, authorized and forbidden", sourceName, scopeStep);
  }
  const scope = rows.slice(1).map((row) => {
    if (row.cells.length !== 3) {
      fail("invalid-procedure", "Every Procedure scope row must contain check, authorized and forbidden", sourceName, row);
    }
    const [check = "", authorized = "", forbidden = ""] = row.cells.map((cell) => cell.value.trim());
    if (check === "" || authorized === "" || forbidden === "") {
      fail("invalid-procedure", "Every Procedure scope row must name a Check and declare both authorized and forbidden boundaries", sourceName, row);
    }
    return {
      check,
      authorized,
      forbidden,
      ...(row.location ? { location: row.location } : {}),
    };
  });
  if (scope.length === 0 || !scope.some(({ check }) => check === "all")) {
    fail("invalid-procedure", "Procedure scope must contain at least one row for all Checks", sourceName, scopeStep);
  }
  return { scope, roles: parseRoles(roleSteps, sourceName) };
}

function parseRoles(steps: readonly Step[], sourceName: string): RoleSource[] {
  return steps.map((step) => {
    if (step.dataTable || step.docString || (step.keyword.trim() !== "Given" && step.keyword.trim() !== "And")) {
      fail("invalid-procedure", "Plan context accepts only role sentences", sourceName, step);
    }
    const parsed = parseProcedureStep(step.text, "background");
    if (parsed?.production !== "role") fail("invalid-procedure", `Invalid role sentence "${step.text}"`, sourceName, step);
    const cardinality = requireCapture(parsed, "cardinality", sourceName, step) as "one" | "many";
    const type = requireCapture(parsed, "value-type", sourceName, step) as ProcedureValueType;
    const name = requireCapture(parsed, "role", sourceName, step);
    if (name === PLAN_ROLE) fail("invalid-procedure", `Role "${PLAN_ROLE}" is reserved for the Plan identifier`, sourceName, step);
    const declared = parsed.captures.some(({ slot }) => slot === "declared");
    const optional = parsed.captures.some(({ slot }) => slot === "optional");
    const fixed = parsed.captures.findLast(({ slot }) => slot === "fixed-value")?.value;
    const parents: { role: string; each: boolean }[] = [];
    for (const capture of parsed.captures) {
      if (capture.slot === "parent-role" || capture.slot === "each-parent-role") {
        parents.push({ role: requireCaptureValue(capture, sourceName, step), each: capture.slot === "each-parent-role" });
      }
    }
    if (fixed === "") fail("invalid-procedure", `Fixed role "${name}" cannot be empty`, sourceName, step);
    if (declared && fixed !== undefined) fail("invalid-procedure", `Role "${name}" cannot be declared and fixed`, sourceName, step);
    if (fixed !== undefined && cardinality !== "one") {
      fail("incompatible-cardinality", `Fixed role "${name}" must have cardinality one`, sourceName, step);
    }
    if (fixed !== undefined && type !== "string" && type !== "reference") {
      fail("incompatible-type", `Fixed role "${name}" must be a string or reference`, sourceName, step);
    }
    return { name, type, cardinality, optional, parents, declared, ...(fixed !== undefined ? { fixed } : {}), location: step.location };
  });
}

function validateProcedureScope(
  scope: readonly CompiledProcedureScope[],
  checks: ReadonlyMap<string, unknown>,
  sourceName: string,
): void {
  for (const row of scope) {
    if (row.check !== "all" && !checks.has(row.check)) {
      fail("invalid-procedure", `Procedure scope references unknown Check "${row.check}"`, sourceName, row);
    }
  }
}

function parseScenario(scenario: Scenario, sourceName: string): ScenarioSource {
  if (scenario.keyword !== "Scenario" || scenario.examples.length > 0) fail("invalid-procedure", "Scenario Outline is outside the closed Procedure grammar", sourceName, scenario);
  const slug = uniqueTag(scenario.tags, SCENARIO_TAG, "Scenario", sourceName, scenario);
  assertOnlyTags(scenario.tags, [SCENARIO_TAG], sourceName, scenario);
  if (!SLUG.test(slug)) fail("invalid-identifier", `Scenario "${slug}" must be a lowercase slug`, sourceName, scenario);
  const dependencies: string[] = [];
  const checks: CheckSource[] = [];
  for (const step of scenario.steps) {
    const dependency = parseDependency(step.text);
    if (dependency) {
      if (checks.length > 0 || (step.keyword.trim() !== "Given" && step.keyword.trim() !== "And") || step.dataTable || step.docString) {
        fail("invalid-dependency", "Scenario dependencies must precede Checks", sourceName, step);
      }
      dependencies.push(dependency);
      continue;
    }
    if (step.keyword.trim() !== "Then" && step.keyword.trim() !== "And") fail("invalid-procedure", "Check placement is invalid", sourceName, step);
    checks.push({
      ...parseCheckSentence(step.text, sourceName, step),
      qualification: parseQualification(step, sourceName),
      location: step.location,
    });
  }
  if (checks.length === 0) fail("invalid-procedure", `Scenario "${slug}" must contain at least one Check`, sourceName, scenario);
  return { slug, title: scenario.name, dependencies, checks, location: scenario.location };
}

function parseDependency(text: string): string | undefined {
  const parsed = parseProcedureStep(text, "scenario");
  if (parsed?.production !== "dependency") return undefined;
  const dependency = parsed.captures.find(({ slot }) => slot === "scenario")?.value;
  return dependency === "" ? undefined : dependency;
}

function parseCheckSentence(text: string, sourceName: string, located: Located): Omit<CheckSource, "qualification" | "location"> {
  const parsed = parseProcedureStep(text, "scenario");
  if (parsed?.production !== "check") fail("invalid-procedure", `Invalid Check sentence "${text}"`, sourceName, located);
  const name = requireCapture(parsed, "check", sourceName, located);
  const operation = requireCapture(parsed, "operation", sourceName, located);
  const selection = parsed.captures.find(({ slot }) => slot === "target-selection")?.value as "each" | "all" | undefined;
  const role = requireCapture(parsed, "target-role", sourceName, located);
  const input = requireCapture(parsed, "input", sourceName, located);
  const using: UsingSource[] = [];
  const materializes: { role: string; field: string }[] = [];
  for (let index = 0; index < parsed.captures.length; index += 1) {
    const capture = parsed.captures[index]!;
    if (capture.slot === "plan-input") using.push({ role: PLAN_ROLE, selection: "one", input: requireCaptureValue(capture, sourceName, located) });
    if (capture.slot === "using-role" || capture.slot === "using-all-role") {
      const inputCapture = parsed.captures[index + 1];
      const expected = capture.slot === "using-all-role" ? "using-all-input" : "using-input";
      if (inputCapture?.slot !== expected) fail("invalid-procedure", `Check "${name}" has an invalid role binding`, sourceName, located);
      using.push({
        role: requireCaptureValue(capture, sourceName, located),
        selection: capture.slot === "using-all-role" ? "all" : "one",
        input: requireCaptureValue(inputCapture, sourceName, located),
      });
    }
    if (capture.slot === "materialized-role") {
      const fieldCapture = parsed.captures[index + 1];
      if (fieldCapture?.slot !== "field") fail("invalid-procedure", `Check "${name}" has an invalid materialization`, sourceName, located);
      materializes.push({ role: requireCaptureValue(capture, sourceName, located), field: requireCaptureValue(fieldCapture, sourceName, located) });
    }
  }
  const successReason = requireCapture(parsed, "reason", sourceName, located);
  return {
    name,
    operation,
    target: { role, selection: selection ?? "one", input },
    using,
    materializes,
    successReason,
  };
}

function parseQualification(step: Step, sourceName: string): QualificationSource {
  if (step.dataTable) {
    fail("invalid-procedure", "Check DataTables are not part of the Procedure language; every Check requires one js DocString", sourceName, step);
  }
  const docString = step.docString;
  if (!docString) fail("invalid-procedure", "Every Check requires one js qualification DocString", sourceName, step);
  if (docString.mediaType !== procedureLanguage.qualification.mediaType) fail("invalid-procedure", "Check qualification DocString content type must be js", sourceName, docString);
  if (docString.content.trim() === "") fail("invalid-procedure", "Check qualification DocString cannot be empty", sourceName, docString);
  const location = docString.location ?? step.location;
  return {
    source: docString.content,
    location: { line: location.line, column: location.column ?? 1 },
  };
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

function validateOptionalRoleDependencies(
  roles: readonly CompiledProcedureRole[],
  sources: ReadonlyMap<string, RoleSource>,
  sourceName: string,
): void {
  const byName = new Map(roles.map((role) => [role.name, role]));
  const hasOptionalDeclarationAncestor = (
    role: CompiledProcedureRole,
    visited: ReadonlySet<string> = new Set(),
  ): boolean => role.parents.some(({ role: parentName }) => {
    if (visited.has(parentName)) return false;
    const parent = byName.get(parentName);
    if (!parent) return false;
    if (parent.source.kind === "agent-declaration" && parent.source.optional === true) return true;
    return hasOptionalDeclarationAncestor(parent, new Set(visited).add(parentName));
  });
  for (const role of roles) {
    if (!hasOptionalDeclarationAncestor(role)) continue;
    if (role.source.kind === "operation-field") continue;
    if (role.source.kind === "agent-declaration" && role.source.optional === true) continue;
    fail(
      "invalid-procedure",
      `Role "${role.name}" depends on an optional agent declaration and must also be declared optionally by agent or materialized by a Check`,
      sourceName,
      sources.get(role.name),
    );
  }
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
  return transitiveScenarioDependencies(current, scenarios).has(expected);
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
  const unknown = tags.find((tag) => !prefixes.some((prefix) => (
    prefix.endsWith(":") ? tag.name.startsWith(prefix) : tag.name === prefix
  )));
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

function parseProcedureStep(text: string, context: "background" | "scenario"): StepGrammarMatch | undefined {
  try {
    return parseStepGrammar(procedureStepGrammar, tokenizeSentence(text), context);
  } catch {
    return undefined;
  }
}

function requireCapture(match: StepGrammarMatch, slot: string, sourceName: string, located: Located): string {
  const capture = match.captures.find((candidate) => candidate.slot === slot);
  if (!capture) fail("invalid-procedure", `Step Grammar omitted required capture "${slot}"`, sourceName, located);
  return requireCaptureValue(capture, sourceName, located);
}

function requireCaptureValue(capture: { readonly slot: string; readonly value: string }, sourceName: string, located: Located): string {
  if (capture.value === "") fail("invalid-procedure", `Capture "${capture.slot}" cannot be empty`, sourceName, located);
  return capture.value;
}
