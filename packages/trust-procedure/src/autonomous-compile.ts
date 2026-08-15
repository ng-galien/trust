import { createHash } from "node:crypto";

import { type GherkinDocument, type Scenario, type Step } from "@cucumber/messages";
import {
  GherkinSyntaxError,
  normalizeGherkinSource,
  parseGherkin,
  tokenizeSentence,
  type SentenceToken,
} from "@trust/gherkin";

import {
  type ActionContractEffect,
  type ActionContractReplay,
  type ActionContractValueType,
  type AutonomousActionContract,
  type AutonomousActionContractDomain,
  type AutonomousActionContractObservation,
  type AutonomousActionContractPortParent,
  type AutonomousActionContractOutputParent,
  type AutonomousProcedureDefinitionCompilationInput,
  type CompiledAutonomousCheck,
  type CompiledAutonomousMaterialization,
  type CompiledAutonomousProcedureDefinition,
  type CompiledAutonomousExpectation,
  type CompiledAutonomousQualificationPredicate,
  type CompiledAutonomousResourceRole,
  type CompiledCapabilityCheckRef,
  type CompiledTargetReference,
  ProcedureCompilationError,
} from "./autonomous-procedure.js";

const PROCEDURE_TAG = "@procedure:";
const VERSION_TAG = "@version:";
const TRUST_DSL_TAG = "@trust-dsl:";
const TRUST_DSL_VERSION = "1";
const SCENARIO_TAG = "@scenario:";
const CANONICAL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CANONICAL_NAME = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/;
const CANONICAL_ACTION = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECRET_LIKE = /(?:^|[^a-z0-9])(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{8,}|bearer\s+[a-z0-9._-]{8,})/i;
const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const AGGREGATION = "the scenario is verified when all Skill actions are validated";
const EFFECTS = new Set<ActionContractEffect>([
  "read",
  "create",
  "update",
  "delete",
  "publish",
  "transition",
  "send",
  "deploy",
]);
const REPLAY_POLICIES = new Set<ActionContractReplay>([
  "replayable",
  "human-intervention",
]);
const VALUE_TYPES = new Set<ActionContractValueType>([
  "string",
  "number",
  "instant",
  "reference",
]);
const QUALIFICATION_RELATIONS = new Set(["equals", "at least", "has at least", "is in", "before", "after"]);

function assertNoSecretLikeValue(value: string, label: string): void {
  if (SECRET_LIKE.test(value)) {
    throw new ProcedureCompilationError(
      "secret-like-value",
      `${label} contains a secret-like value`,
    );
  }
}

function semanticCapabilitySegment(capability: string): string {
  assertNoSecretLikeValue(capability, "Capability");
  if (!CANONICAL_ACTION.test(capability)) {
    throw new ProcedureCompilationError(
      "invalid-skill-action",
      "Skill action must use the canonical <skill>.<action> form",
    );
  }
  return capability.replace(".", "-");
}

interface CompileContext {
  readonly sourceName: string;
}

interface Located {
  readonly location?: { readonly line: number; readonly column?: number };
}

interface ParsedRole {
  readonly name: string;
  readonly cardinality: "one" | "many";
  readonly parents: readonly { readonly role: string; readonly each: boolean }[];
  readonly fixed?: string;
  readonly agentDeclared: boolean;
  readonly location: { readonly line: number; readonly column?: number };
}

interface CapabilityBuilder {
  readonly capability: string;
  effect?: ActionContractEffect;
  replay?: ActionContractReplay;
  inputs?: AutonomousActionContract["inputs"];
  observations?: AutonomousActionContract["observations"];
  outputs?: AutonomousActionContract["outputs"];
  readonly location: { readonly line: number; readonly column?: number };
}

interface ParsedInputBinding {
  readonly input: string;
  readonly role: string;
  readonly selection: "one" | "each" | "all";
}

interface ParsedTarget {
  readonly primary: ParsedInputBinding;
  readonly using: readonly ParsedInputBinding[];
}

interface ParsedPredicate {
  readonly observation: string;
  readonly relation: string;
  readonly expectation: string;
  readonly failureFeedback: string;
  readonly location: { readonly line: number; readonly column?: number };
}

interface ParsedMaterialization {
  readonly role: string;
  readonly output: string;
}

interface ParsedAction {
  readonly nodeId: string;
  readonly scenario: string;
  readonly capability: string;
  readonly target: ParsedTarget;
  readonly checkName: string;
  readonly materializes: readonly ParsedMaterialization[];
  readonly successFeedback: string;
  readonly predicates: readonly ParsedPredicate[];
  readonly location: { readonly line: number; readonly column?: number };
}

interface ParsedScenario {
  readonly slug: string;
  readonly title: string;
  readonly dependencies: readonly string[];
  readonly actions: readonly ParsedAction[];
  readonly location: { readonly line: number; readonly column?: number };
}

export function compileAutonomousProcedureDefinition(
  input: AutonomousProcedureDefinitionCompilationInput,
): CompiledAutonomousProcedureDefinition {
  const context: CompileContext = { sourceName: input.sourceName ?? "<procedure>" };
  const source = normalizeGherkinSource(input.source);
  assertNoSecretLikeValue(source, "procedure source");
  let document: GherkinDocument;
  try {
    document = parseGherkin(source);
  } catch (error) {
    if (!(error instanceof GherkinSyntaxError)) throw error;
    fail(
      context,
      "invalid-procedure",
      `Procedure is not valid Gherkin: ${error.message}`,
      error.location ? { location: error.location } : undefined,
    );
  }
  const feature = document.feature;
  if (!feature || feature.language !== "en") {
    fail(context, "invalid-procedure", "Procedure must contain one English Gherkin Feature");
  }
  if (feature.children.some((child) => child.rule)) {
    fail(context, "invalid-procedure", "Rules are outside the closed procedure grammar", feature);
  }

  const procedure = readUniqueTag(feature.tags, PROCEDURE_TAG, "procedure", context, feature);
  if (!CANONICAL_SLUG.test(procedure) || procedure.length > 63) {
    fail(context, "noncanonical-slug", `Procedure slug "${procedure}" must be a canonical lowercase slug`, feature);
  }
  const version = readUniqueTag(feature.tags, VERSION_TAG, "version", context, feature);
  if (!SEMANTIC_VERSION.test(version)) {
    fail(context, "noncanonical-slug", `Procedure version "${version}" must be semantic`, feature);
  }
  const trustDslVersion = readUniqueTag(
    feature.tags,
    TRUST_DSL_TAG,
    "TRUST DSL version",
    context,
    feature,
  );
  if (trustDslVersion !== TRUST_DSL_VERSION) {
    fail(
      context,
      "invalid-procedure",
      `TRUST DSL version "${trustDslVersion}" is unsupported; expected "${TRUST_DSL_VERSION}"`,
      feature,
    );
  }
  assertOnlyTags(
    feature.tags,
    [PROCEDURE_TAG, VERSION_TAG, TRUST_DSL_TAG],
    "Feature",
    context,
    feature,
  );

  const backgrounds = feature.children.flatMap((child) => child.background ? [child.background] : []);
  if (backgrounds.length !== 1 || !backgrounds[0]) {
    fail(context, "missing-background", "Procedure must declare exactly one Background", feature);
  }
  const parsedInterface = parseProcedureInterface(backgrounds[0].steps, context);
  const capabilityByName = new Map(
    parsedInterface.capabilities.map((item) => [item.capability, item.contract]),
  );
  const roleByName = new Map(parsedInterface.roles.map((role) => [role.name, role]));
  for (const [capability, contract] of capabilityByName) {
    validateCapabilityContract(capability, contract, context);
  }

  const scenarioNodes = feature.children.flatMap((child) => child.scenario ? [child.scenario] : []);
  if (scenarioNodes.length === 0) {
    fail(context, "invalid-procedure", "Procedure must declare at least one Scenario", feature);
  }
  const scenarios = scenarioNodes.map((scenario) => parseScenario(scenario, context));
  validateScenarios(scenarios, context);

  const actions = scenarios.flatMap((scenario) => scenario.actions);
  const usedCapabilities = new Set(actions.map((action) => action.capability));
  for (const capability of capabilityByName.keys()) {
    if (!usedCapabilities.has(capability)) {
      fail(context, "invalid-procedure", `Skill capability "${capability}" is declared but unused`);
    }
  }
  validateCapabilitySegments(usedCapabilities, context);
  validateCheckIdentity(procedure, version, scenarios, roleByName, context);

  const roleProviders = new Map<string, ParsedAction[]>();
  const materializationsByAction = new Map<string, readonly CompiledAutonomousMaterialization[]>();
  const inferredRoleTypes = new Map<string, ActionContractValueType>();
  const checkNames = new Set<string>();
  for (const action of actions) {
    const contract = capabilityByName.get(action.capability);
    if (!contract) {
      fail(
        context,
        "unknown-action",
        `Check "${action.checkName}" uses undeclared Skill capability "${action.capability}"`,
        action,
      );
    }
    const materializations = validateAction(
      action,
      contract,
      roleByName,
      inferredRoleTypes,
      context,
    );
    materializationsByAction.set(action.nodeId, materializations);
    if (checkNames.has(action.checkName)) {
      fail(context, "invalid-procedure", `Check name "${action.checkName}" is not unique`, action);
    }
    checkNames.add(action.checkName);
    for (const materialization of action.materializes) {
      const providers = roleProviders.get(materialization.role) ?? [];
      roleProviders.set(materialization.role, [...providers, action]);
    }
  }

  validateRoleGraph(parsedInterface.roles, context);
  validateMaterializationAvailability(scenarios, roleProviders, context);

  const requirements = [...capabilityByName.entries()]
    .filter(([capability]) => usedCapabilities.has(capability))
    .map(([capability, contract]) => {
      const contractCoreDigest = digest({
        schema: "trust.action-contract-core@1",
        capability,
        contract: normalizeContract(contract),
      });
      return {
        capability,
        contractCoreDigest,
        actionContractDigest: actionContractDigest(capability, contractCoreDigest),
        contract: normalizeContract(contract),
      };
    })
    .sort((left, right) => left.capability.localeCompare(right.capability));
  const requirementByCapability = new Map(requirements.map((item) => [item.capability, item]));

  const initialCheckTemplates: CompiledAutonomousCheck[] = actions.map((action) => {
    const requirement = requirementByCapability.get(action.capability);
    const contract = capabilityByName.get(action.capability);
    if (!requirement || !contract) {
      fail(context, "unknown-action", `Check "${action.checkName}" uses undeclared Skill capability "${action.capability}"`, action);
    }
    const ref = capabilityRef(action);
    const inputBindings = [action.target.primary, ...action.target.using].map((binding) => ({
      input: binding.input,
      role: binding.role,
      selection: binding.selection,
    }));
    const materializes = materializationsByAction.get(action.nodeId) ?? [];
    const qualification = {
      kind: "all" as const,
      predicates: compilePredicates(
        action,
        contract,
        roleByName,
        actions,
        scenarios,
        capabilityByName,
        context,
      ),
    };
    const checkBody = {
      ref,
      capabilityContract: {
        capability: action.capability,
        digest: requirement.actionContractDigest,
      },
      uriTemplate: {
        procedure,
        version,
        scenario: action.scenario,
        capabilitySegment: semanticCapabilitySegment(action.capability),
        target: compileTarget(action.target),
      },
      name: action.checkName,
      requiredCheckObservations: [],
      inputBindings,
      materializes,
      successFeedback: action.successFeedback,
      qualification,
    };
    return {
      ...checkBody,
      compiledCheckDigest: semanticDigest({ schema: "trust.compiled-check@1", check: checkBody }),
    };
  });

  const requiredCheckObservations = new Map<string, Set<string>>();
  for (const consumer of initialCheckTemplates) {
    for (const predicate of consumer.qualification.predicates) {
      const expectation = predicate.expectation;
      if (expectation.kind !== "check-observation") continue;
      const providerAction = actions.find(
        (candidate) => candidate.checkName === expectation.check,
      );
      if (!providerAction) {
        fail(
          context,
          "unknown-upstream-field",
          `Check "${expectation.check}" has no provider`,
        );
      }
      if (providerAction.target.primary.selection === "each") {
        fail(
          context,
          "invalid-procedure",
          `Check "${expectation.check}" expands to several materialized Checks and cannot provide one observation projection`,
          providerAction,
        );
      }
      const key = canonicalJson(capabilityRef(providerAction));
      const observations = requiredCheckObservations.get(key) ?? new Set<string>();
      observations.add(expectation.observation);
      requiredCheckObservations.set(key, observations);
    }
  }
  const checkTemplates: CompiledAutonomousCheck[] = initialCheckTemplates.map((template) => {
    const required = [...(requiredCheckObservations.get(canonicalJson(template.ref)) ?? [])]
      .sort((left, right) => left.localeCompare(right));
    const { compiledCheckDigest: _compiledCheckDigest, ...initialBody } = template;
    const checkBody = { ...initialBody, requiredCheckObservations: required };
    return {
      ...checkBody,
      compiledCheckDigest: semanticDigest({ schema: "trust.compiled-check@1", check: checkBody }),
    };
  });

  const roles: CompiledAutonomousResourceRole[] = parsedInterface.roles.map((role) => {
    const providers = roleProviders.get(role.name) ?? [];
    const providerMaterialization = providers[0]?.materializes.find((item) => item.role === role.name);
    if (role.agentDeclared && providers.length > 0) {
      fail(
        context,
        "invalid-procedure",
        `Agent-declared role "${role.name}" cannot also be materialized by a Skill`,
        role,
      );
    }
    return {
      name: role.name,
      cardinality: role.cardinality,
      parents: role.parents,
      valueType: inferredRoleTypes.get(role.name) ?? "reference",
      materialization: role.fixed
        ? { kind: "static", value: role.fixed }
        : role.agentDeclared
          ? { kind: "agent-declaration" }
        : providers.length > 0 && providerMaterialization
          ? {
              kind: "capability-output",
              output: providerMaterialization.output,
              providers: providers.map(capabilityRef),
            }
          : { kind: "plan-input" },
    };
  });
  const compiledScenarios = scenarios.map((scenario) => ({
    slug: scenario.slug,
    title: scenario.title,
    dependencies: [...scenario.dependencies],
    aggregation: "all-skill-actions" as const,
    checks: scenario.actions.map(capabilityRef),
  }));
  const semanticDefinition = {
    contract: "trust.compiled-procedure@2" as const,
    procedure,
    version,
    title: feature.name.trim(),
    requiredCapabilities: requirements,
    roles,
    scenarios: compiledScenarios,
    checkTemplates,
  };
  return {
    ...semanticDefinition,
    source,
    definitionDigest: semanticDigest({
      schema: "trust.semantic-procedure-definition@1",
      definition: semanticDefinition,
    }),
  };
}

function parseProcedureInterface(
  steps: readonly Step[],
  context: CompileContext,
): {
  readonly capabilities: ReadonlyArray<{
    capability: string;
    contract: AutonomousActionContract;
  }>;
  readonly roles: readonly ParsedRole[];
} {
  const capabilities = new Map<string, CapabilityBuilder>();
  const roles: ParsedRole[] = [];
  const roleNames = new Set<string>();
  for (const step of steps) {
    const keyword = step.keyword.trim();
    if (keyword !== "Given" && keyword !== "And") {
      fail(context, "invalid-procedure", "Background declarations must use Given or And", step);
    }
    const header = step.text.match(/^Skill capability "([^"]+)" performs ([a-z-]+) and is ([a-z-]+)$/);
    if (header) {
      assertNoStepArgument(step, context);
      const capability = header[1] ?? "";
      const effect = header[2] as ActionContractEffect;
      const replay = header[3] as ActionContractReplay;
      assertCapability(capability, context, step);
      if (!EFFECTS.has(effect) || !REPLAY_POLICIES.has(replay)) {
        fail(context, "invalid-procedure", `Skill capability "${capability}" has an invalid effect or replay policy`, step);
      }
      if (capabilities.has(capability)) {
        fail(context, "duplicate-capability", `Skill capability "${capability}" is declared more than once`, step);
      }
      capabilities.set(capability, {
        capability,
        effect,
        replay,
        location: step.location,
      });
      continue;
    }
    const section = step.text.match(/^Skill capability "([^"]+)" (accepts|reports|exposes outputs)$/);
    if (section) {
      const capability = section[1] ?? "";
      const builder = capabilities.get(capability);
      if (!builder) {
        fail(context, "incomplete-capability", `Skill capability "${capability}" must be introduced before its contract tables`, step);
      }
      const kind = section[2];
      if (kind === "accepts") {
        if (builder.inputs) fail(context, "duplicate-capability", `Skill capability "${capability}" repeats accepts`, step);
        builder.inputs = parseInputs(step, context);
      } else if (kind === "reports") {
        if (builder.observations) fail(context, "duplicate-capability", `Skill capability "${capability}" repeats reports`, step);
        builder.observations = parseObservations(step, context);
      } else {
        if (builder.outputs) fail(context, "duplicate-capability", `Skill capability "${capability}" repeats outputs`, step);
        builder.outputs = parseOutputs(step, context);
      }
      continue;
    }
    const noOutputs = step.text.match(/^Skill capability "([^"]+)" exposes no outputs$/);
    if (noOutputs) {
      assertNoStepArgument(step, context);
      const capability = noOutputs[1] ?? "";
      const builder = capabilities.get(capability);
      if (!builder || builder.outputs) {
        fail(context, "incomplete-capability", `Skill capability "${capability}" cannot declare no outputs here`, step);
      }
      builder.outputs = {};
      continue;
    }
    roles.push(parseRole(step, roleNames, context));
  }
  if (capabilities.size === 0) {
    fail(context, "incomplete-capability", "Procedure interface must declare at least one Skill capability");
  }
  if (roles.length === 0) {
    fail(context, "missing-background", "Procedure interface must declare governed context");
  }
  return {
    capabilities: [...capabilities.values()].map((builder) => {
      if (
        !builder.effect
        || !builder.replay
        || !builder.inputs
        || !builder.observations
        || !builder.outputs
      ) {
        fail(context, "incomplete-capability", `Skill capability "${builder.capability}" is incomplete`, builder);
      }
      const contract = normalizeContract({
        effect: builder.effect,
        replay: builder.replay,
        inputs: builder.inputs,
        observations: builder.observations,
        outputs: builder.outputs,
      });
      return {
        capability: builder.capability,
        contract,
      };
    }),
    roles,
  };
}

function parseInputs(step: Step, context: CompileContext): AutonomousActionContract["inputs"] {
  const rows = requireTable(step, ["input", "type", "cardinality"], context);
  const result: Record<string, AutonomousActionContract["inputs"][string]> = {};
  for (const row of rows) {
    const input = row.cells[0]?.value.trim() ?? "";
    const type = row.cells[1]?.value.trim() as ActionContractValueType;
    const shape = parsePortCardinality(row.cells[2]?.value.trim() ?? "", ["input"], context, row);
    assertCanonicalName(input, "capability input", context, row);
    if (result[input]) fail(context, "invalid-procedure", `Capability input "${input}" is repeated`, row);
    if (!VALUE_TYPES.has(type)) {
      fail(context, "invalid-procedure", `Capability input "${input}" has an invalid shape`, row);
    }
    result[input] = {
      type,
      cardinality: shape.cardinality,
      parents: shape.parents.map((parent) => ({
        kind: parent.kind as "input" | "observation",
        port: parent.port,
      })),
    };
  }
  return result;
}

function parsePortCardinality(
  text: string,
  allowedParentKinds: readonly ("input" | "observation")[],
  context: CompileContext,
  located: Located,
): {
  readonly cardinality: "one" | "many";
  readonly parents: readonly { readonly kind: "input" | "observation"; readonly port: string }[];
} {
  if (text === "one" || text === "many") {
    return { cardinality: text, parents: [] };
  }
  const correlated = text.match(/^one for each (input|observation) "([^"]+)"$/);
  if (!correlated) {
    fail(
      context,
      "invalid-procedure",
      `Port cardinality "${text}" must be one, many or one for each <kind> "<port>"`,
      located,
    );
  }
  const kind = correlated[1] as "input" | "observation";
  const port = correlated[2] ?? "";
  if (!allowedParentKinds.includes(kind)) {
    fail(context, "invalid-procedure", `Correlated ${kind} parent is not allowed here`, located);
  }
  assertCanonicalName(port, "correlated parent port", context, located);
  return { cardinality: "one", parents: [{ kind, port }] };
}

function parseObservations(
  step: Step,
  context: CompileContext,
): AutonomousActionContract["observations"] {
  const rows = requireTable(step, ["observation", "type", "cardinality", "domain"], context);
  const result: Record<string, {
    type: ActionContractValueType;
    cardinality: "one" | "many";
    domain: AutonomousActionContractDomain;
    parents: readonly AutonomousActionContractPortParent[];
  }> = {};
  for (const row of rows) {
    const observation = row.cells[0]?.value.trim() ?? "";
    const type = row.cells[1]?.value.trim() as ActionContractValueType;
    const shape = parsePortCardinality(
      row.cells[2]?.value.trim() ?? "",
      ["input", "observation"],
      context,
      row,
    );
    const domain = parseDomain(row.cells[3]?.value.trim() ?? "", context, row);
    assertCanonicalName(observation, "capability observation", context, row);
    if (result[observation]) fail(context, "invalid-procedure", `Capability observation "${observation}" is repeated`, row);
    if (!VALUE_TYPES.has(type)) {
      fail(context, "invalid-procedure", `Capability observation "${observation}" has an invalid shape`, row);
    }
    if (domain.kind === "enum" && type !== "string") {
      fail(context, "invalid-procedure", `Only string observation "${observation}" may use an enum domain`, row);
    }
    result[observation] = {
      type,
      cardinality: shape.cardinality,
      parents: shape.parents.map((parent) => ({
        kind: parent.kind as "input" | "observation",
        port: parent.port,
      })),
      domain,
    };
  }
  return result;
}

function parseOutputs(step: Step, context: CompileContext): AutonomousActionContract["outputs"] {
  const table = step.dataTable?.rows ?? [];
  const header = table[0]?.cells.map((cell) => cell.value.trim()) ?? [];
  if (step.docString || canonicalJson(header) !== canonicalJson(["output", "from observation", "parents"])) {
    fail(context, "invalid-procedure", "Table must declare output | from observation | parents", step);
  }
  const rows = table.slice(1);
  const result: Record<string, { observation: string; parents: readonly AutonomousActionContractOutputParent[] }> = {};
  for (const row of rows) {
    const output = row.cells[0]?.value.trim() ?? "";
    const observation = row.cells[1]?.value.trim() ?? "";
    const parents = parseOutputParents(row.cells[2]?.value.trim() ?? "", context, row);
    assertCanonicalName(output, "capability output", context, row);
    assertCanonicalName(observation, "capability output observation", context, row);
    if (result[output]) fail(context, "invalid-procedure", `Capability output "${output}" is repeated`, row);
    result[output] = { observation, parents };
  }
  return result;
}

function parseRole(step: Step, declared: Set<string>, context: CompileContext): ParsedRole {
  const match = step.text.match(
    /^(one|many) "([^"]+)"(?: (declared by agent))?(?: fixed as "([^"]+)"| for each "([^"]+)"| for (.+))?$/,
  );
  if (!match) {
    fail(context, "invalid-procedure", "Procedure interface declaration does not match the closed grammar", step);
  }
  assertNoStepArgument(step, context);
  const cardinality = match[1] as "one" | "many";
  const name = match[2] ?? "";
  const agentDeclared = match[3] !== undefined;
  const fixed = match[4];
  if (agentDeclared && fixed !== undefined) {
    fail(context, "invalid-procedure", `Agent-declared role "${name}" cannot be fixed`, step);
  }
  assertCanonicalName(name, "procedure role", context, step);
  if (declared.has(name)) fail(context, "invalid-procedure", `Procedure role "${name}" is repeated`, step);
  declared.add(name);
  const parents = match[5]
    ? [{ role: match[5], each: true }]
    : match[6]
      ? parseQuotedNames(match[6], context, step).map((role) => ({ role, each: false }))
      : [];
  if (match[5] && cardinality !== "one") {
    fail(context, "invalid-procedure", `Per-member role "${name}" must have cardinality one`, step);
  }
  return {
    name,
    cardinality,
    parents,
    agentDeclared,
    ...(fixed ? { fixed } : {}),
    location: step.location,
  };
}

function parseScenario(scenario: Scenario, context: CompileContext): ParsedScenario {
  if (scenario.keyword !== "Scenario" || scenario.examples.length > 0) {
    fail(context, "invalid-procedure", "Scenario Outlines are outside the closed grammar", scenario);
  }
  const slug = readUniqueTag(scenario.tags, SCENARIO_TAG, "scenario", context, scenario);
  if (!CANONICAL_SLUG.test(slug) || slug.length > 63) {
    fail(context, "noncanonical-slug", `Scenario slug "${slug}" must be canonical`, scenario);
  }
  assertOnlyTags(scenario.tags, [SCENARIO_TAG], "Scenario", context, scenario);
  const dependencies: string[] = [];
  const actions: ParsedAction[] = [];
  let aggregated = false;
  for (const [index, step] of scenario.steps.entries()) {
    if (step.text === AGGREGATION) {
      assertNoStepArgument(step, context);
      if (step.keyword.trim() !== "And" || index !== scenario.steps.length - 1) {
        fail(context, "invalid-procedure", "Scenario aggregation must be the final And step", step);
      }
      aggregated = true;
      continue;
    }
    const dependency = step.text.match(/^scenario "([^"]+)" is validated$/);
    if (dependency && actions.length === 0) {
      assertNoStepArgument(step, context);
      if (step.keyword.trim() !== "Given" && step.keyword.trim() !== "And") {
        fail(context, "invalid-procedure", "Scenario dependencies must use Given or And", step);
      }
      dependencies.push(dependency[1] ?? "");
      continue;
    }
    if (step.text.startsWith('Check "')) {
      const expectedKeyword = actions.length === 0 ? "Then" : "And";
      if (step.keyword.trim() !== expectedKeyword) {
        fail(context, "invalid-procedure", `Check ${actions.length + 1} must use ${expectedKeyword}`, step);
      }
      actions.push(parseAction(step, slug, actions.length, context));
      continue;
    }
    fail(context, "invalid-procedure", `Unsupported Scenario step: ${step.text}`, step);
  }
  if (!aggregated || actions.length === 0) {
    fail(context, "invalid-procedure", "Scenario must contain Checks and final aggregation", scenario);
  }
  return { slug, title: scenario.name.trim(), dependencies, actions, location: scenario.location };
}

function parseAction(
  step: Step,
  scenario: string,
  actionIndex: number,
  context: CompileContext,
): ParsedAction {
  let tokens: readonly SentenceToken[];
  try {
    tokens = tokenizeSentence(step.text);
  } catch {
    fail(context, "implicit-synonym", "Check step does not match the closed grammar", step);
  }
  const cursor: SentenceCursor = { tokens, index: 0 };
  requireText(cursor, "Check", context, step);
  const checkName = requireQuoted(cursor, context, step);
  requireText(cursor, "uses", context, step);
  requireText(cursor, "Skill", context, step);
  requireText(cursor, "capability", context, step);
  const capability = requireQuoted(cursor, context, step);
  requireText(cursor, "on", context, step);
  const primary = parseInputBinding(cursor, ["each", "all"], context, step);
  const using: ParsedInputBinding[] = [];
  if (takeText(cursor, "using")) {
    using.push(...parseInputBindings(cursor, context, step));
  }
  const materializes = matchesText(cursor, "and", "materializes")
    ? parseMaterializations(cursor, context, step)
    : [];
  requireText(cursor, "and", context, step);
  requireText(cursor, "must", context, step);
  requireText(cursor, "establish", context, step);
  const successFeedback = requireQuoted(cursor, context, step).trim();
  if (cursor.index !== cursor.tokens.length) {
    fail(context, "implicit-synonym", "Check step does not match the closed grammar", step);
  }
  assertCanonicalName(checkName, "Check name", context, step);
  assertCapability(capability, context, step);
  if (!successFeedback) fail(context, "invalid-procedure", "Check success feedback is empty", step);
  return {
    nodeId: `${scenario}#${actionIndex}`,
    scenario,
    capability,
    target: { primary, using },
    checkName,
    materializes,
    successFeedback,
    predicates: parseQualification(step, context),
    location: step.location,
  };
}

interface SentenceCursor {
  readonly tokens: readonly SentenceToken[];
  index: number;
}

function parseInputBindings(
  cursor: SentenceCursor,
  context: CompileContext,
  located: Located,
): ParsedInputBinding[] {
  const bindings: ParsedInputBinding[] = [];
  while (true) {
    bindings.push(parseInputBinding(cursor, ["all"], context, located));
    if (takeComma(cursor)) continue;
    if (matchesText(cursor, "and", "materializes") || matchesText(cursor, "and", "must")) break;
    if (takeText(cursor, "and")) continue;
    break;
  }
  return bindings;
}

function parseMaterializations(
  cursor: SentenceCursor,
  context: CompileContext,
  located: Located,
): ParsedMaterialization[] {
  requireText(cursor, "and", context, located, "materialization-source-missing");
  requireText(cursor, "materializes", context, located, "materialization-source-missing");
  const materializations: ParsedMaterialization[] = [];
  while (true) {
    const role = requireQuoted(cursor, context, located, "materialization-source-missing");
    requireText(cursor, "from", context, located, "materialization-source-missing");
    requireText(cursor, "output", context, located, "materialization-source-missing");
    const output = requireQuoted(cursor, context, located, "materialization-source-missing");
    materializations.push({ role, output });
    if (takeComma(cursor)) continue;
    if (matchesText(cursor, "and", "must")) break;
    if (takeText(cursor, "and")) continue;
    fail(context, "materialization-source-missing", "Invalid materialization separator", located);
  }
  return materializations;
}

function parseInputBinding(
  cursor: SentenceCursor,
  selections: readonly ("each" | "all")[],
  context: CompileContext,
  located: Located,
): ParsedInputBinding {
  const token = cursor.tokens[cursor.index];
  const selection = token?.kind === "text"
    && selections.includes(token.value as "each" | "all")
    ? token.value as "each" | "all"
    : "one";
  if (selection !== "one") cursor.index += 1;
  const role = requireQuoted(cursor, context, located);
  requireText(cursor, "as", context, located);
  requireText(cursor, "input", context, located);
  const input = requireQuoted(cursor, context, located);
  assertCanonicalName(role, "input role", context, located);
  assertCanonicalName(input, "input port", context, located);
  return { role, input, selection };
}

function matchesText(cursor: SentenceCursor, ...values: readonly string[]): boolean {
  return values.every((value, offset) => {
    const token = cursor.tokens[cursor.index + offset];
    return token?.kind === "text" && token.value === value;
  });
}

function takeText(cursor: SentenceCursor, value: string): boolean {
  if (!matchesText(cursor, value)) return false;
  cursor.index += 1;
  return true;
}

function requireText(
  cursor: SentenceCursor,
  value: string,
  context: CompileContext,
  located: Located,
  code: "implicit-synonym" | "materialization-source-missing" = "implicit-synonym",
): void {
  if (!takeText(cursor, value)) {
    fail(context, code, "Check step does not match the closed grammar", located);
  }
}

function requireQuoted(
  cursor: SentenceCursor,
  context: CompileContext,
  located: Located,
  code: "implicit-synonym" | "materialization-source-missing" = "implicit-synonym",
): string {
  const token = cursor.tokens[cursor.index];
  if (token?.kind !== "quoted" || token.value.length === 0) {
    fail(context, code, "Check step does not match the closed grammar", located);
  }
  cursor.index += 1;
  return token.value;
}

function takeComma(cursor: SentenceCursor): boolean {
  if (cursor.tokens[cursor.index]?.kind !== "comma") return false;
  cursor.index += 1;
  return true;
}

function parseQualification(step: Step, context: CompileContext): ParsedPredicate[] {
  const rows = requireTable(
    step,
    ["observation", "relation", "expectation", "failure feedback"],
    context,
  );
  return rows.map((row) => {
    const feedbackToken = row.cells[3]?.value.trim() ?? "";
    const feedback = feedbackToken.match(/^"([^"]+)"$/)?.[1];
    if (!feedback) fail(context, "missing-failure-feedback", "Failure feedback must be quoted", row);
    return {
      observation: row.cells[0]?.value.trim() ?? "",
      relation: row.cells[1]?.value.trim() ?? "",
      expectation: row.cells[2]?.value.trim() ?? "",
      failureFeedback: feedback,
      location: row.location,
    };
  });
}

function validateAction(
  action: ParsedAction,
  contract: AutonomousActionContract,
  roles: ReadonlyMap<string, ParsedRole>,
  inferredRoleTypes: Map<string, ActionContractValueType>,
  context: CompileContext,
): readonly CompiledAutonomousMaterialization[] {
  const bindings = [action.target.primary, ...action.target.using];
  const bindingByInput = new Map(bindings.map((binding) => [binding.input, binding]));
  const seenInputs = new Set<string>();
  for (const binding of bindings) {
    if (seenInputs.has(binding.input)) {
      fail(context, "input-unbound", `Input "${binding.input}" is bound more than once`, action);
    }
    seenInputs.add(binding.input);
    const input = contract.inputs[binding.input];
    const role = roles.get(binding.role);
    if (!input) fail(context, "input-unbound", `Input "${binding.input}" is not declared by capability "${action.capability}"`, action);
    if (!role) fail(context, "unknown-context-role", `Role "${binding.role}" is not declared`, action);
    validateBindingSelection(binding, role, action.target.primary, context, action);
    const effective = binding.selection === "all"
      ? "many"
      : effectiveRoleCardinality(role, action.target.primary);
    const wireCardinality = input.parents.length > 0 ? "many" : input.cardinality;
    if (wireCardinality !== effective) {
      fail(context, "incompatible-use-cardinality", `Input "${binding.input}" expects ${wireCardinality} but binding is ${effective}`, action);
    }
    const existing = inferredRoleTypes.get(binding.role);
    if (existing && existing !== input.type) {
      fail(context, "incompatible-relation-type", `Role "${binding.role}" has incompatible input types`, action);
    }
    inferredRoleTypes.set(binding.role, input.type);
  }
  for (const input of Object.keys(contract.inputs)) {
    if (!seenInputs.has(input)) fail(context, "input-unbound", `Required input "${input}" is not bound`, action);
  }
  for (const [inputName, input] of Object.entries(contract.inputs)) {
    if (input.parents.length === 0) continue;
    const binding = bindingByInput.get(inputName);
    const parent = input.parents[0];
    const parentBinding = parent?.kind === "input" ? bindingByInput.get(parent.port) : undefined;
    const role = binding ? roles.get(binding.role) : undefined;
    if (
      !binding
      || binding.selection !== "all"
      || !parentBinding
      || parentBinding.selection !== "all"
      || !role
      || !role.parents.some(
        (candidate) => candidate.each && candidate.role === parentBinding.role,
      )
    ) {
      fail(
        context,
        "incompatible-use-cardinality",
        `Correlated input "${inputName}" must bind all values of a role declared one for each role bound to input "${parent?.port ?? ""}"`,
        action,
      );
    }
  }
  const outputToRole = new Map<string, string>();
  const mappedRoles = new Set<string>();
  for (const materialization of action.materializes) {
    const output = contract.outputs[materialization.output];
    const role = roles.get(materialization.role);
    if (!output) fail(context, "unknown-output", `Output "${materialization.output}" is not declared`, action);
    if (!role) fail(context, "unknown-context-role", `Role "${materialization.role}" is not declared`, action);
    if (outputToRole.has(materialization.output)) {
      fail(context, "duplicate-output-provider", `Output "${materialization.output}" is materialized more than once`, action);
    }
    if (mappedRoles.has(materialization.role)) {
      fail(context, "duplicate-output-provider", `Role "${materialization.role}" is materialized more than once`, action);
    }
    if (role.fixed) {
      fail(context, "fixed-role-output", `Fixed role "${materialization.role}" cannot be materialized`, action);
    }
    if (materialization.role === action.target.primary.role) {
      fail(context, "target-produced-by-same-action", `Action cannot materialize its primary target role`, action);
    }
    const observation = contract.observations[output.observation];
    if (!observation) fail(context, "unknown-observation", `Output "${materialization.output}" has no authentic observation`, action);
    const nestedIncarnations = observation.cardinality === "many" &&
      role.cardinality === "one" &&
      role.parents.some((parent) => parent.each);
    if (role.cardinality !== observation.cardinality && !nestedIncarnations) {
      fail(
        context,
        "incompatible-target-cardinality",
        `Output "${materialization.output}" is ${observation.cardinality} but role "${materialization.role}" is ${role.cardinality}`,
        action,
      );
    }
    const existing = inferredRoleTypes.get(materialization.role);
    if (existing && existing !== observation.type) {
      fail(
        context,
        "incompatible-relation-type",
        `Role "${materialization.role}" is constrained as both ${existing} and ${observation.type}`,
        action,
      );
    }
    inferredRoleTypes.set(materialization.role, observation.type);
    outputToRole.set(materialization.output, materialization.role);
    mappedRoles.add(materialization.role);
  }
  const selectedOutputs = new Set(outputToRole.keys());
  for (const outputName of selectedOutputs) {
    for (const parent of contract.outputs[outputName]?.parents ?? []) {
      if (parent.kind === "output" && !selectedOutputs.has(parent.port)) {
        fail(
          context,
          "materialization-source-missing",
          `Output "${outputName}" requires materialized parent output "${parent.port}"`,
          action,
        );
      }
    }
  }
  return action.materializes.map((materialization) => {
    const output = contract.outputs[materialization.output];
    const observation = output ? contract.observations[output.observation] : undefined;
    const role = roles.get(materialization.role);
    if (!output || !observation || !role) {
      fail(context, "materialization-source-missing", `Materialization "${materialization.output}" cannot be resolved`, action);
    }
    const parents = output.parents.map((parent) => {
      const parentRole = parent.kind === "input"
        ? bindingByInput.get(parent.port)?.role
        : outputToRole.get(parent.port);
      if (!parentRole) {
        fail(
          context,
          "materialization-source-missing",
          `${parent.kind} parent port "${parent.port}" is not bound by this Check`,
          action,
        );
      }
      const topology = role.parents.find((candidate) => candidate.role === parentRole);
      if (!topology) {
        fail(
          context,
          "unbound-output-scope",
          `Role "${role.name}" is not declared for parent role "${parentRole}"`,
          action,
        );
      }
      return {
        kind: parent.kind,
        port: parent.port,
        role: parentRole,
        each: topology.each,
      };
    });
    const expectedParents = [...role.parents]
      .map((parent) => `${parent.role}:${String(parent.each)}`)
      .sort();
    const resolvedParents = parents
      .map((parent) => `${parent.role}:${String(parent.each)}`)
      .sort();
    if (canonicalJson(expectedParents) !== canonicalJson(resolvedParents)) {
      fail(
        context,
        "unbound-output-scope",
        `Output "${materialization.output}" does not bind the exact parent topology of role "${role.name}"`,
        action,
      );
    }
    return {
      output: materialization.output,
      role: materialization.role,
      observation: output.observation,
      valueType: observation.type,
      sourceCardinality: observation.cardinality,
      cardinality: role.cardinality,
      parents,
    };
  });
}

function validateBindingSelection(
  binding: ParsedInputBinding,
  role: ParsedRole,
  primary: ParsedInputBinding,
  context: CompileContext,
  located: Located,
): void {
  const collection = isCollectionRole(role);
  if (binding === primary) {
    if (binding.selection === "one" && collection) {
      fail(
        context,
        "ambiguous-collection-target",
        `Collection role "${role.name}" requires each or all selection`,
        located,
      );
    }
    if (binding.selection !== "one" && !collection) {
      fail(
        context,
        "incompatible-target-cardinality",
        `Singular role "${role.name}" cannot use ${binding.selection} selection`,
        located,
      );
    }
    return;
  }
  const effective = effectiveRoleCardinality(role, primary);
  if (binding.selection === "all" && effective !== "many") {
    fail(
      context,
      "incompatible-use-cardinality",
      `Role "${role.name}" is singular in this Check and cannot use all`,
      located,
    );
  }
  if (binding.selection === "one" && effective === "many") {
    const memberParents = role.parents.filter((parent) => parent.each);
    const correlated = primary.selection === "each" &&
      memberParents.some((parent) => parent.role === primary.role);
    fail(
      context,
      correlated ? "incompatible-use-cardinality" : "ambiguous-collection-use",
      `Collection role "${role.name}" is not singular in this Check scope`,
      located,
    );
  }
}

function validateCapabilityContract(
  capability: string,
  contract: AutonomousActionContract,
  context: CompileContext,
): void {
  for (const [inputName, input] of Object.entries(contract.inputs)) {
    for (const parent of input.parents) {
      const parentInput = parent.kind === "input" ? contract.inputs[parent.port] : undefined;
      if (!parentInput) {
        fail(
          context,
          "input-unbound",
          `Capability "${capability}" input "${inputName}" refers to unknown input parent "${parent.port}"`,
        );
      }
      if (parent.port === inputName || parentInput.cardinality !== "many" || parentInput.parents.length > 0) {
        fail(
          context,
          "incompatible-relation-type",
          `Capability "${capability}" input "${inputName}" requires one uncorrelated many parent input`,
        );
      }
    }
  }
  for (const [observationName, observation] of Object.entries(contract.observations)) {
    for (const parent of observation.parents) {
      const parentField = parent.kind === "input"
        ? contract.inputs[parent.port]
        : contract.observations[parent.port];
      if (!parentField) {
        fail(
          context,
          parent.kind === "input" ? "input-unbound" : "unknown-observation",
          `Capability "${capability}" observation "${observationName}" refers to unknown ${parent.kind} parent "${parent.port}"`,
        );
      }
      if (
        (parent.kind === "observation" && parent.port === observationName)
        || parentField.cardinality !== "many"
        || parentField.parents.length > 0
      ) {
        fail(
          context,
          "incompatible-relation-type",
          `Capability "${capability}" observation "${observationName}" requires one uncorrelated many parent port`,
        );
      }
    }
  }
  for (const [outputName, output] of Object.entries(contract.outputs)) {
    if (!contract.observations[output.observation]) {
      fail(
        context,
        "unknown-observation",
        `Capability "${capability}" output "${outputName}" refers to unknown observation "${output.observation}"`,
      );
    }
    const seenParents = new Set<string>();
    for (const parent of output.parents) {
      const key = `${parent.kind}:${parent.port}`;
      if (seenParents.has(key)) {
        fail(
          context,
          "invalid-procedure",
          `Capability "${capability}" output "${outputName}" repeats parent ${key}`,
        );
      }
      seenParents.add(key);
      if (parent.kind === "input" && !contract.inputs[parent.port]) {
        fail(
          context,
          "input-unbound",
          `Capability "${capability}" output "${outputName}" refers to unknown input parent "${parent.port}"`,
        );
      }
      if (parent.kind === "output" && !contract.outputs[parent.port]) {
        fail(
          context,
          "unknown-output",
          `Capability "${capability}" output "${outputName}" refers to unknown output parent "${parent.port}"`,
        );
      }
      if (parent.kind === "output" && parent.port === outputName) {
        fail(
          context,
          "dependency-cycle",
          `Capability "${capability}" output "${outputName}" cannot parent itself`,
        );
      }
    }
  }
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (outputName: string): void => {
    const cycleStart = visiting.indexOf(outputName);
    if (cycleStart >= 0) {
      fail(
        context,
        "dependency-cycle",
        `Capability "${capability}" output graph contains a cycle: ${[
          ...visiting.slice(cycleStart),
          outputName,
        ].join(" -> ")}`,
      );
    }
    if (visited.has(outputName)) return;
    visiting.push(outputName);
    for (const parent of contract.outputs[outputName]?.parents ?? []) {
      if (parent.kind === "output") visit(parent.port);
    }
    visiting.pop();
    visited.add(outputName);
  };
  for (const outputName of Object.keys(contract.outputs)) visit(outputName);
}

function compilePredicates(
  action: ParsedAction,
  contract: AutonomousActionContract,
  roles: ReadonlyMap<string, ParsedRole>,
  actions: readonly ParsedAction[],
  scenarios: readonly ParsedScenario[],
  capabilityByName: ReadonlyMap<string, AutonomousActionContract>,
  context: CompileContext,
): CompiledAutonomousQualificationPredicate[] {
  return action.predicates.map((predicate) => {
    if (!QUALIFICATION_RELATIONS.has(predicate.relation)) {
      fail(context, "unknown-relation", `Relation "${predicate.relation}" is not supported`, predicate);
    }
    const observation = contract.observations[predicate.observation];
    if (!observation) {
      fail(context, "unknown-observation", `Observation "${predicate.observation}" is not declared`, predicate);
    }
    const observationCardinality = observation.parents.length > 0 ? "many" : observation.cardinality;
    const expectation = compileExpectation(
      predicate,
      observation,
      contract,
      action,
      roles,
      actions,
      scenarios,
      capabilityByName,
      context,
    );
    validatePredicateShapes(
      predicate,
      observation,
      observationCardinality,
      expectation,
      contract,
      capabilityByName,
      context,
    );
    return {
      observation: predicate.observation,
      observationType: observation.type,
      observationCardinality,
      observationParents: observation.parents,
      relation: predicate.relation as CompiledAutonomousQualificationPredicate["relation"],
      expectation,
      failureFeedback: predicate.failureFeedback,
    };
  });
}

function compileExpectation(
  predicate: ParsedPredicate,
  observation: AutonomousActionContract["observations"][string],
  contract: AutonomousActionContract,
  action: ParsedAction,
  roles: ReadonlyMap<string, ParsedRole>,
  actions: readonly ParsedAction[],
  scenarios: readonly ParsedScenario[],
  capabilityByName: ReadonlyMap<string, AutonomousActionContract>,
  context: CompileContext,
): CompiledAutonomousExpectation {
  const contextMatch = predicate.expectation.match(/^context "([^"]+)"$/);
  if (contextMatch) {
    const roleName = contextMatch[1] ?? "";
    const role = roles.get(roleName);
    const binding = [action.target.primary, ...action.target.using].find((item) => item.role === roleName);
    if (!role || !binding) fail(context, "unbound-context-reference", `Context role "${roleName}" is not bound`, predicate);
    const input = contract.inputs[binding.input];
    if (!input) fail(context, "input-unbound", `Input "${binding.input}" is not declared`, predicate);
    return {
      kind: "context",
      role: roleName,
      valueType: input.type,
      cardinality: input.parents.length > 0 || binding.selection === "all" ? "many" : "one",
      parents: input.parents,
    };
  }
  const checkObservationMatch = predicate.expectation.match(
    /^observation "([^"]+)" from Check "([^"]+)"$/,
  );
  if (checkObservationMatch) {
    const observationName = checkObservationMatch[1] ?? "";
    const checkName = checkObservationMatch[2] ?? "";
    const provider = actions.find((candidate) => candidate.checkName === checkName);
    if (!provider || !scenarioTransitivelyDependsOn(action.scenario, provider.scenario, scenarios)) {
      fail(
        context,
        "unknown-upstream-field",
        `Check "${checkName}" is not provided by an upstream scenario`,
        predicate,
      );
    }
    const providerObservation = capabilityByName.get(provider.capability)?.observations[observationName];
    if (!providerObservation) {
      fail(
        context,
        "unknown-upstream-field",
        `Check "${checkName}" has no observation "${observationName}"`,
        predicate,
      );
    }
    return {
      kind: "check-observation",
      check: checkName,
      provider: capabilityRef(provider),
      observation: observationName,
      valueType: providerObservation.type,
      cardinality: providerObservation.parents.length > 0 ? "many" : providerObservation.cardinality,
      parents: providerObservation.parents,
    };
  }
  if (observation.type === "instant" && predicate.expectation === "valid rfc3339") {
    return {
      kind: "valid-value",
      token: "valid rfc3339",
      codec: "rfc3339",
      valueType: "instant",
      cardinality: "one",
    };
  }
  const numberMatch = predicate.expectation.match(/^number (-?\d+(?:\.\d+)?)$/);
  if (numberMatch) {
    const value = Number(numberMatch[1]);
    return {
      kind: "literal",
      token: predicate.expectation,
      value,
      valueType: "number",
      cardinality: "one",
    };
  }
  const literalMatch = predicate.expectation.match(/^literal "([^"]+)"$/);
  if (observation.type === "string" &&
    literalMatch &&
    (observation.domain.kind === "any" || observation.domain.values.includes(literalMatch[1] ?? ""))) {
    const value = literalMatch[1] ?? "";
    return {
      kind: "literal",
      token: predicate.expectation,
      value,
      valueType: "string",
      cardinality: "one",
    };
  }
  fail(
    context,
    "invalid-procedure",
    `Expectation "${predicate.expectation}" must use literal, number, valid rfc3339, context or observation from Check syntax and match the observation domain`,
    predicate,
  );
}

function validatePredicateShapes(
  predicate: ParsedPredicate,
  observation: AutonomousActionContract["observations"][string],
  observationCardinality: "one" | "many",
  expectation: CompiledAutonomousExpectation,
  contract: AutonomousActionContract,
  capabilityByName: ReadonlyMap<string, AutonomousActionContract>,
  context: CompileContext,
): void {
  const incompatible = (): never => fail(
    context,
    "incompatible-relation-type",
    `Observation "${predicate.observation}" and expectation have incompatible shapes for relation ${predicate.relation}`,
    predicate,
  );
  const sameType = expectation.valueType === observation.type;
  if (predicate.relation === "equals") {
    if (!sameType || expectation.cardinality !== observationCardinality) incompatible();
    const actualParents = parentValueTypes(observation.parents, contract, context);
    const expectedParents = expectation.kind === "context"
      ? parentValueTypes(expectation.parents, contract, context)
      : expectation.kind === "check-observation"
        ? parentValueTypes(
            expectation.parents,
            capabilityByName.get(expectation.provider.capability) ?? contract,
            context,
          )
        : [];
    if (canonicalJson(actualParents.sort()) !== canonicalJson(expectedParents.sort())) incompatible();
    return;
  }
  if (predicate.relation === "at least") {
    if (
      observation.type !== "number"
      || observationCardinality !== "one"
      || expectation.valueType !== "number"
      || expectation.cardinality !== "one"
    ) incompatible();
    return;
  }
  if (predicate.relation === "has at least") {
    if (
      observationCardinality !== "many"
      || expectation.valueType !== "number"
      || expectation.cardinality !== "one"
    ) incompatible();
    return;
  }
  if (predicate.relation === "before" || predicate.relation === "after") {
    if (
      observation.type !== "instant"
      || observationCardinality !== "one"
      || expectation.valueType !== "instant"
      || expectation.cardinality !== "one"
      || expectation.kind === "valid-value"
    ) incompatible();
    return;
  }
  if (predicate.relation === "is in") {
    if (
      !sameType
      || observationCardinality !== "one"
      || expectation.cardinality !== "many"
      || ((expectation.kind === "context" || expectation.kind === "check-observation")
        && expectation.parents.length > 0)
    ) incompatible();
  }
}

function parentValueTypes(
  parents: readonly AutonomousActionContractPortParent[],
  contract: AutonomousActionContract,
  context: CompileContext,
): string[] {
  return parents.map((parent) => {
    const port = parent.kind === "input"
      ? contract.inputs[parent.port]
      : contract.observations[parent.port];
    if (!port) {
      fail(
        context,
        "incompatible-relation-type",
        `Parent ${parent.kind} "${parent.port}" is unavailable while typing a predicate`,
      );
    }
    return port.type;
  });
}

function scenarioTransitivelyDependsOn(
  consumer: string,
  provider: string,
  scenarios: readonly ParsedScenario[],
): boolean {
  if (consumer === provider) return false;
  const bySlug = new Map(scenarios.map((scenario) => [scenario.slug, scenario]));
  const pending = [...(bySlug.get(consumer)?.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (!candidate || visited.has(candidate)) continue;
    if (candidate === provider) return true;
    visited.add(candidate);
    pending.push(...(bySlug.get(candidate)?.dependencies ?? []));
  }
  return false;
}

function validateScenarios(scenarios: readonly ParsedScenario[], context: CompileContext): void {
  const bySlug = new Map<string, ParsedScenario>();
  for (const scenario of scenarios) {
    if (bySlug.has(scenario.slug)) fail(context, "duplicate-scenario-slug", `Scenario "${scenario.slug}" is repeated`, scenario);
    bySlug.set(scenario.slug, scenario);
  }
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (slug: string): void => {
    if (visiting.includes(slug)) fail(context, "dependency-cycle", `Scenario dependency cycle: ${[...visiting, slug].join(" -> ")}`);
    if (visited.has(slug)) return;
    const scenario = bySlug.get(slug);
    if (!scenario) fail(context, "unknown-scenario-dependency", `Unknown scenario "${slug}"`);
    visiting.push(slug);
    for (const dependency of scenario.dependencies) visit(dependency);
    visiting.pop();
    visited.add(slug);
  };
  for (const slug of bySlug.keys()) visit(slug);
}

function validateCapabilitySegments(
  capabilities: ReadonlySet<string>,
  context: CompileContext,
): void {
  const owners = new Map<string, string>();
  for (const capability of capabilities) {
    const segment = semanticCapabilitySegment(capability);
    if (segment.length > 63) {
      fail(
        context,
        "invalid-skill-action",
        `Skill capability "${capability}" projects to an oversized URI segment`,
      );
    }
    const owner = owners.get(segment);
    if (owner && owner !== capability) {
      fail(
        context,
        "action-uri-segment-collision",
        `Skill capabilities "${owner}" and "${capability}" project to the same URI segment`,
      );
    }
    owners.set(segment, capability);
  }
}

function validateCheckIdentity(
  procedure: string,
  version: string,
  scenarios: readonly ParsedScenario[],
  roles: ReadonlyMap<string, ParsedRole>,
  context: CompileContext,
): void {
  type Expansion =
    | { readonly kind: "none" }
    | { readonly kind: "fixed"; readonly value: string }
    | { readonly kind: "dynamic" };
  const expansionsByBase = new Map<string, Expansion[]>();
  const overlaps = (left: Expansion, right: Expansion): boolean => {
    if (left.kind === "none" || right.kind === "none") {
      return left.kind === "none" && right.kind === "none";
    }
    if (left.kind === "dynamic" || right.kind === "dynamic") return true;
    return left.value === right.value;
  };
  for (const scenario of scenarios) {
    for (const action of scenario.actions) {
      const primary = roles.get(action.target.primary.role);
      if (!primary) continue;
      const expansion: Expansion = primary.fixed
        ? { kind: "fixed", value: primary.fixed }
        : action.target.primary.selection === "each"
          ? { kind: "dynamic" }
          : { kind: "none" };
      const base = canonicalJson({
        procedure,
        version,
        scenario: scenario.slug,
        capabilitySegment: semanticCapabilitySegment(action.capability),
      });
      const existing = expansionsByBase.get(base) ?? [];
      if (existing.some((candidate) => overlaps(candidate, expansion))) {
        fail(
          context,
          "uri-collision",
          `Duplicate Check URI template for scenario "${scenario.slug}", capability "${action.capability}", target "${action.target.primary.role}"`,
          action,
        );
      }
      expansionsByBase.set(base, [...existing, expansion]);
    }
  }
}

function validateRoleGraph(roles: readonly ParsedRole[], context: CompileContext): void {
  const byName = new Map(roles.map((role) => [role.name, role]));
  for (const role of roles) {
    for (const parent of role.parents) {
      if (!byName.has(parent.role)) fail(context, "unknown-context-role", `Role "${role.name}" has unknown parent "${parent.role}"`, role);
    }
  }
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (roleName: string): void => {
    const cycleStart = visiting.indexOf(roleName);
    if (cycleStart >= 0) {
      fail(
        context,
        "dependency-cycle",
        `Role dependency cycle: ${[...visiting.slice(cycleStart), roleName].join(" -> ")}`,
        byName.get(roleName),
      );
    }
    if (visited.has(roleName)) return;
    visiting.push(roleName);
    for (const parent of byName.get(roleName)?.parents ?? []) visit(parent.role);
    visiting.pop();
    visited.add(roleName);
  };
  for (const roleName of byName.keys()) visit(roleName);
}

function validateMaterializationAvailability(
  scenarios: readonly ParsedScenario[],
  providers: ReadonlyMap<string, readonly ParsedAction[]>,
  context: CompileContext,
): void {
  const scenarioBySlug = new Map(scenarios.map((scenario) => [scenario.slug, scenario]));
  const dependencies = (scenario: ParsedScenario): Set<string> => {
    const result = new Set<string>();
    const visit = (slug: string): void => {
      const candidate = scenarioBySlug.get(slug);
      if (!candidate) return;
      for (const dependency of candidate.dependencies) {
        if (result.has(dependency)) continue;
        result.add(dependency);
        visit(dependency);
      }
    };
    visit(scenario.slug);
    return result;
  };
  for (const scenario of scenarios) {
    const availableScenarios = dependencies(scenario);
    for (const action of scenario.actions) {
      for (const binding of [action.target.primary, ...action.target.using]) {
        const candidates = providers.get(binding.role) ?? [];
        if (candidates.length === 0) continue;
        const available = candidates.filter((provider) => availableScenarios.has(provider.scenario));
        if (available.length === 0) {
          fail(context, "target-not-materialized", `Role "${binding.role}" is not materialized before scenario "${scenario.slug}"`, action);
        }
        if (available.length > 1) {
          fail(context, "ambiguous-output-provider", `Role "${binding.role}" has multiple providers`, action);
        }
      }
    }
  }
}

function parseDomain(text: string, context: CompileContext, located: Located): AutonomousActionContractDomain {
  if (text === "any") return { kind: "any" };
  const match = text.match(/^enum (.+)$/);
  if (!match) fail(context, "invalid-procedure", `Invalid observation domain "${text}"`, located);
  const values = parseQuotedNames(match[1] ?? "", context, located).sort();
  if (new Set(values).size !== values.length) fail(context, "invalid-procedure", "Observation enum repeats a value", located);
  return { kind: "enum", values };
}

function parseOutputParents(
  text: string,
  context: CompileContext,
  located: Located,
): AutonomousActionContractOutputParent[] {
  const parents: AutonomousActionContractOutputParent[] = [];
  let rest = text;
  while (rest) {
    const match = rest.match(/^(input|output) "([^"]+)"/);
    if (!match) fail(context, "invalid-procedure", `Invalid output parents "${text}"`, located);
    parents.push({ kind: match[1] as "input" | "output", port: match[2] ?? "" });
    rest = rest.slice((match[0] ?? "").length);
    if (!rest) break;
    if (rest.startsWith(", ")) rest = rest.slice(2);
    else if (rest.startsWith(" and ")) rest = rest.slice(5);
    else fail(context, "invalid-procedure", `Invalid output parent separator "${text}"`, located);
  }
  return parents;
}

function requireTable(step: Step, header: readonly string[], context: CompileContext) {
  const rows = step.dataTable?.rows ?? [];
  const actual = rows[0]?.cells.map((cell) => cell.value.trim()) ?? [];
  if (step.docString || canonicalJson(actual) !== canonicalJson(header) || rows.length < 2) {
    fail(context, "invalid-procedure", `Table must declare ${header.join(" | ")}`, step);
  }
  return rows.slice(1);
}

function assertNoStepArgument(step: Step, context: CompileContext): void {
  if (step.dataTable || step.docString) {
    fail(context, "invalid-procedure", `Step "${step.text}" cannot carry a DataTable or DocString`, step);
  }
}

function parseQuotedNames(text: string, context: CompileContext, located: Located): string[] {
  const names: string[] = [];
  let rest = text;
  while (rest) {
    const match = rest.match(/^"([^"]+)"/);
    if (!match) fail(context, "invalid-procedure", `Invalid quoted list "${text}"`, located);
    names.push(match[1] ?? "");
    rest = rest.slice((match[0] ?? "").length);
    if (!rest) break;
    if (rest.startsWith(", ")) rest = rest.slice(2);
    else if (rest.startsWith(" and ")) rest = rest.slice(5);
    else fail(context, "invalid-procedure", `Invalid quoted list separator "${text}"`, located);
  }
  return names;
}

function capabilityRef(action: ParsedAction): CompiledCapabilityCheckRef {
  return {
    scenario: action.scenario,
    capability: action.capability,
    target: compileTarget(action.target),
  };
}

function compileTarget(target: ParsedTarget): CompiledTargetReference {
  return {
    primary: { role: target.primary.role, selection: target.primary.selection },
    using: target.using.map((binding) => ({
      role: binding.role,
      selection: binding.selection as "one" | "all",
    })),
  };
}

function normalizeContract(contract: AutonomousActionContract): AutonomousActionContract {
  return {
    effect: contract.effect,
    replay: contract.replay,
    inputs: sortRecord(contract.inputs, (input) => ({
      type: input.type,
      cardinality: input.cardinality,
      parents: [...input.parents]
        .map((parent) => ({ ...parent }))
        .sort((left, right) => `${left.kind}:${left.port}`.localeCompare(`${right.kind}:${right.port}`)),
    })),
    observations: sortRecord(contract.observations, (observation) => ({
      type: observation.type,
      cardinality: observation.cardinality,
      domain: observation.domain.kind === "any"
        ? { kind: "any" as const }
        : { kind: "enum" as const, values: [...observation.domain.values].sort() },
      parents: [...observation.parents]
        .map((parent) => ({ ...parent }))
        .sort((left, right) => `${left.kind}:${left.port}`.localeCompare(`${right.kind}:${right.port}`)),
    })),
    outputs: sortRecord(contract.outputs, (output) => ({
      observation: output.observation,
      parents: [...output.parents]
        .map((parent) => ({ ...parent }))
        .sort((left, right) => `${left.kind}:${left.port}`.localeCompare(`${right.kind}:${right.port}`)),
    })),
  };
}

function actionContractDigest(
  capability: string,
  contractCoreDigest: string,
): string {
  return digest({
    schema: "trust.action-contract@4",
    capability,
    contractCoreDigest,
  });
}

function isCollectionRole(role: ParsedRole): boolean {
  return role.cardinality === "many" || role.parents.some((parent) => parent.each);
}

function effectiveRoleCardinality(
  role: ParsedRole,
  primary: ParsedInputBinding,
): "one" | "many" {
  if (primary.selection === "each" && role.name === primary.role) return "one";
  if (role.cardinality === "many") return "many";
  const correlated = primary.selection === "each" &&
    role.parents.some((parent) => parent.each && parent.role === primary.role);
  return role.parents.some((parent) => parent.each) && !correlated ? "many" : "one";
}

/**
 * Procedure and Check array members are closed named sets (ports, predicates,
 * parents, cases and dependencies), never positional programs. Canonicalizing
 * their order keeps editor reformatting and table-row ordering out of semantic
 * identity while preserving duplicate multiplicity for fail-closed validation.
 */
function semanticDigest(value: unknown): string {
  return digest(canonicalizeSemanticCollections(value));
}

function canonicalizeSemanticCollections(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalizeSemanticCollections)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeSemanticCollections(item)]),
    );
  }
  return value;
}

function sortRecord<T, R>(record: Readonly<Record<string, T>>, project: (value: T) => R): Record<string, R> {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, project(value)]),
  );
}

function readUniqueTag(
  tags: readonly { readonly name: string; readonly location: { readonly line: number; readonly column?: number } }[],
  prefix: string,
  label: string,
  context: CompileContext,
  located: Located,
): string {
  const matches = tags.filter((tag) => tag.name.startsWith(prefix));
  if (matches.length !== 1) fail(context, "invalid-procedure", `Procedure must declare exactly one ${label} tag`, located);
  return matches[0]?.name.slice(prefix.length) ?? "";
}

function assertCapability(capability: string, context: CompileContext, located: Located): void {
  if (!CANONICAL_ACTION.test(capability)) {
    fail(context, "invalid-skill-action", `Skill capability "${capability}" must use <domain>.<action>`, located);
  }
}

function assertCanonicalName(name: string, label: string, context: CompileContext, located: Located): void {
  if (!CANONICAL_NAME.test(name) || name.length > 63) {
    fail(context, "invalid-identifier", `${label} "${name}" must be canonical lowercase text`, located);
  }
}

function assertCanonicalSlug(
  value: string,
  label: string,
  context: CompileContext,
  located: Located,
): void {
  if (!CANONICAL_SLUG.test(value) || value.length > 63) {
    fail(context, "noncanonical-slug", `${label} "${value}" must be a canonical slug`, located);
  }
}

function assertOnlyTags(
  tags: readonly { readonly name: string }[],
  allowedPrefixes: readonly string[],
  label: string,
  context: CompileContext,
  located: Located,
): void {
  for (const tag of tags) {
    if (!allowedPrefixes.some((prefix) => tag.name.startsWith(prefix))) {
      fail(context, "invalid-procedure", `${label} tag "${tag.name}" is outside the closed grammar`, located);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function fail(
  context: CompileContext,
  code: ConstructorParameters<typeof ProcedureCompilationError>[0],
  message: string,
  located?: Located,
): never {
  const location = located?.location;
  throw new ProcedureCompilationError(
    code,
    message,
    context.sourceName,
    location ? { line: location.line, column: location.column ?? 1 } : undefined,
  );
}
