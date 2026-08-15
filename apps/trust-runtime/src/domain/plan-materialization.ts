import { createHash } from "node:crypto";
import { isRfc3339Instant } from "./rfc3339.js";

import { buildSemanticCheckUri } from "./check-uri.js";
import type {
  ActionContractValueType,
  CompiledAutonomousCheck,
  CompiledAutonomousProcedureDefinition,
  CompiledAutonomousResourceRole,
  CompiledCapabilityCheckRef,
} from "@trust/procedure";
import type {
  ActiveCheckQualification,
  MaterializationOutputContract,
  MaterializedCheck,
  MaterializedPlanRevision,
  MaterializedRoleIncarnation,
  PlanMaterializationState,
  RuntimeJsonObject,
  ValidatedFactBatch,
  ValidatedOutputProjection,
  ValidatedCheckObservationProjection,
} from "./runtime-model.js";

export interface PlanMaterializationInput {
  readonly authority: string;
  readonly definition: CompiledAutonomousProcedureDefinition;
  readonly planSlug: string;
  readonly environment: string;
  readonly rootInputs: RuntimeJsonObject;
  readonly agentDeclarations?: RuntimeJsonObject;
  readonly agentDeclarationActivations?: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly materializationState?: PlanMaterializationState;
  readonly instantiatedChecks?: readonly MaterializedCheck[];
  /**
   * Incarnations omitted by a newly VALIDATED provider batch. A previously
   * instantiated Check whose semantic target is one of these incarnations is
   * absent from the new revision instead of being carried forward as OPEN.
   */
  readonly authoritativelyRemovedRoleIncarnations?: readonly MaterializedRoleIncarnation[];
  readonly authoritativelyRemovedAgentDeclarations?: readonly {
    readonly role: string;
    readonly value: unknown;
  }[];
  readonly activeQualifications?: readonly Pick<
    ActiveCheckQualification,
    "planSlug" | "planRevision" | "checkUri" | "activationDigest"
  >[];
}

const EMPTY_MATERIALIZATION_STATE: PlanMaterializationState = Object.freeze({
  roleIncarnations: Object.freeze([]),
  validatedOutputs: Object.freeze([]),
  validatedCheckObservations: Object.freeze([]),
});

export function materializePlanRevision(
  input: PlanMaterializationInput,
): MaterializedPlanRevision {
  const rootInputs = validateRootInputs(input.definition.roles, input.rootInputs);
  const agentDeclarations = validateAgentDeclarations(
    input.definition.roles,
    rootInputs,
    input.agentDeclarations ?? Object.freeze({}),
  );
  const agentDeclarationActivations = validateAgentDeclarationActivations(
    input.definition.roles,
    agentDeclarations,
    input.agentDeclarationActivations ?? Object.freeze({}),
  );
  const state = validateMaterializationState(
    input.definition.roles,
    input.materializationState ?? EMPTY_MATERIALIZATION_STATE,
  );
  const context = materializationContext(
    input.definition.roles,
    rootInputs,
    agentDeclarations,
    state,
  );
  const scenarioDependencies = new Map(
    input.definition.scenarios.map((scenario) => [scenario.slug, scenario.dependencies]),
  );
  const drafts: MaterializedCheckDraft[] = [];
  const uris = new Set<string>();

  const requirements = new Map(
    input.definition.requiredCapabilities.map((requirement) => [
      `${requirement.capability}\0${requirement.actionContractDigest}`,
      requirement,
    ]),
  );
  for (const template of input.definition.checkTemplates) {
    const requirement = requirements.get(
      `${template.capabilityContract.capability}\0${template.capabilityContract.digest}`,
    );
    if (!requirement) {
      throw new TypeError(
        `published capability contract ${template.capabilityContract.capability}@${template.capabilityContract.digest} is unavailable during materialization`,
      );
    }
    const contract = requirement.contract;
    const materializationContract = compileMaterializationContract(
      template,
      input.definition.roles,
    );
    for (const binding of targetBindings(
      template,
      contract,
      input.definition.roles,
      context,
    )) {
      const uri = buildSemanticCheckUri({
        authority: input.authority,
        procedure: input.definition.procedure,
        version: input.definition.version,
        plan: input.planSlug,
        scenario: template.uriTemplate.scenario,
        capability: template.capabilityContract.capability,
        ...(binding.expansion.length === 0 ? {} : { expansion: binding.expansion }),
      });
      if (uris.has(uri)) {
        throw new TypeError(`materialized Check URI collision: ${uri}`);
      }
      uris.add(uri);
      drafts.push({
        uri,
        planSlug: input.planSlug,
        planRevision: input.revision,
        scenario: template.uriTemplate.scenario,
        expansion: binding.expansion,
        template,
        actionInput: binding.actionInput,
        factContract: {
          contractVersion: "trust.action-contract@3",
          inputs: contract.inputs,
          outputs: contract.outputs,
          observations: contract.observations,
        },
        materializationContract,
        checkDependencies: [],
        scenarioDependencies:
          scenarioDependencies.get(template.uriTemplate.scenario) ?? [],
      });
    }
  }

  const boundDrafts = drafts.flatMap((draft) => {
    const checkDependencies = resolveCheckDependencies(
      draft,
      drafts,
      state.validatedCheckObservations,
    );
    return checkDependencies === undefined
      ? []
      : [{ ...draft, checkDependencies }];
  });
  const activationByCheckUri = activeQualificationMap(input);
  const contextCandidates = currentContextCandidates(
    boundDrafts,
    input.instantiatedChecks ?? [],
  );
  const rematerializedChecks = boundDrafts.map((draft) => {
    const currentContextDigest = deriveCurrentContextDigest(
      draft,
      contextCandidates,
      activationByCheckUri,
      input.definition.roles,
      agentDeclarationActivations,
    );
    const base = {
      ...draft,
      ...(currentContextDigest === undefined ? {} : { currentContextDigest }),
    } satisfies Omit<MaterializedCheck, "compiledCheckDigest">;
    return {
      ...base,
      // A revision only records when this semantic representation was current.
      // It is deliberately not part of the representation digest itself.
      compiledCheckDigest: canonicalDigest(semanticCheckRepresentation(base)),
    };
  });
  const rematerializedUris = new Set(rematerializedChecks.map((check) => check.uri));
  const retainedChecks = (input.instantiatedChecks ?? [])
    .filter((check) => !rematerializedUris.has(check.uri))
    .filter((check) => !hasAuthoritativelyRemovedTarget(
      check,
      input.authoritativelyRemovedRoleIncarnations ?? [],
      input.authoritativelyRemovedAgentDeclarations ?? [],
    ))
    .map((check) => retainInstantiatedCheck(check, input, state));
  const checks = [...rematerializedChecks, ...retainedChecks]
    .sort((left, right) => left.uri.localeCompare(right.uri));

  return {
    procedure: input.definition.procedure,
    procedureVersion: input.definition.version,
    environment: input.environment,
    rootInputs,
    agentDeclarations,
    agentDeclarationActivations,
    planSlug: input.planSlug,
    revision: input.revision,
    definitionDigest: input.definition.definitionDigest,
    source: input.definition.source,
    checks,
    roleIncarnations: state.roleIncarnations,
    validatedOutputs: state.validatedOutputs,
    validatedCheckObservations: state.validatedCheckObservations,
  };
}

function hasAuthoritativelyRemovedTarget(
  check: MaterializedCheck,
  removed: readonly MaterializedRoleIncarnation[],
  removedDeclarations: readonly { readonly role: string; readonly value: unknown }[],
): boolean {
  if (check.expansion.length !== 1) return false;
  const target = check.template.uriTemplate.target.primary;
  if (target.selection === "all") return false;
  const [targetIdentity] = check.expansion;
  return [...removed, ...removedDeclarations].some(
    (incarnation) =>
      incarnation.role === target.role
      && canonicalJson(incarnation.value) === canonicalJson(targetIdentity),
  );
}

/**
 * A role projection may temporarily be unavailable after its provider is
 * requalified. The Check that was already instantiated from that role remains
 * part of the Plan; only its current qualification is removed. Its last action
 * input is retained while dependency gates prevent delegation, and a later
 * provider qualification rematerializes the same semantic Check URI. A target
 * explicitly omitted by a VALIDATED authoritative provider batch is excluded
 * before this temporary-context retention applies.
 */
function retainInstantiatedCheck(
  check: MaterializedCheck,
  input: PlanMaterializationInput,
  state: PlanMaterializationState,
): MaterializedCheck {
  if (check.planSlug !== input.planSlug) {
    throw new TypeError(`instantiated Check ${check.uri} belongs to another Plan`);
  }
  const checkDependencies = Object.freeze(check.checkDependencies.map((dependency) => {
    const projection = state.validatedCheckObservations.find(
      (candidate) =>
        candidate.checkName === dependency.checkName
        && candidate.providerCheckUri === dependency.providerCheckUri,
    );
    return Object.freeze({
      checkName: dependency.checkName,
      providerCheckUri: dependency.providerCheckUri,
      ...(projection === undefined ? {} : { observationDigest: canonicalDigest(projection) }),
    });
  }));
  const {
    compiledCheckDigest: _previousCompiledCheckDigest,
    currentContextDigest: _previousCurrentContextDigest,
    ...previous
  } = check;
  const base = {
    ...previous,
    planRevision: input.revision,
    checkDependencies,
  } satisfies Omit<MaterializedCheck, "compiledCheckDigest">;
  return Object.freeze({
    ...base,
    compiledCheckDigest: canonicalDigest(semanticCheckRepresentation(base)),
  });
}

function activeQualificationMap(
  input: PlanMaterializationInput,
): ReadonlyMap<string, Pick<
  ActiveCheckQualification,
  "planSlug" | "planRevision" | "checkUri" | "activationDigest"
>> {
  const result = new Map<string, Pick<
    ActiveCheckQualification,
    "planSlug" | "planRevision" | "checkUri" | "activationDigest"
  >>();
  for (const qualification of input.activeQualifications ?? []) {
    if (
      qualification.planSlug !== input.planSlug
      || qualification.planRevision !== input.revision
    ) {
      throw new TypeError(
        `active qualification ${qualification.checkUri} belongs to another Plan revision`,
      );
    }
    if (result.has(qualification.checkUri)) {
      throw new TypeError(
        `active qualification ${qualification.checkUri} is duplicated`,
      );
    }
    result.set(qualification.checkUri, qualification);
  }
  return result;
}

function currentContextCandidates(
  drafts: readonly MaterializedCheckDraft[],
  instantiatedChecks: readonly MaterializedCheck[],
): readonly Pick<MaterializedCheck, "uri" | "scenario">[] {
  const byUri = new Map<string, Pick<MaterializedCheck, "uri" | "scenario">>();
  for (const check of instantiatedChecks) {
    byUri.set(check.uri, { uri: check.uri, scenario: check.scenario });
  }
  for (const draft of drafts) {
    byUri.set(draft.uri, { uri: draft.uri, scenario: draft.scenario });
  }
  return [...byUri.values()];
}

function deriveCurrentContextDigest(
  check: MaterializedCheckDraft & {
    readonly checkDependencies: MaterializedCheck["checkDependencies"];
  },
  candidates: readonly Pick<MaterializedCheck, "uri" | "scenario">[],
  activeQualifications: ReadonlyMap<string, Pick<
    ActiveCheckQualification,
    "checkUri" | "activationDigest"
  >>,
  roles: readonly CompiledAutonomousResourceRole[],
  agentDeclarationActivations: Readonly<Record<string, string>>,
): string | undefined {
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  const declarationQualifications = check.template.inputBindings
    .map((binding) => binding.role)
    .filter((role, index, all) => all.indexOf(role) === index)
    .filter((role) => roleByName.get(role)?.materialization.kind === "agent-declaration")
    .map((role) => {
      const activationDigest = agentDeclarationActivations[role];
      if (activationDigest === undefined) {
        throw new TypeError(`agent declaration ${role} has no activation identity`);
      }
      return { role, activationDigest };
    })
    .sort((left, right) => left.role.localeCompare(right.role));
  const scenarioQualifications: {
    scenario: string;
    checkUri: string;
    activationDigest: string;
  }[] = [];
  for (const scenario of check.scenarioDependencies) {
    const providers = candidates
      .filter((candidate) => candidate.scenario === scenario)
      .sort((left, right) => left.uri.localeCompare(right.uri));
    if (providers.length === 0) return undefined;
    for (const provider of providers) {
      const active = activeQualifications.get(provider.uri);
      if (!active) return undefined;
      scenarioQualifications.push({
        scenario,
        checkUri: provider.uri,
        activationDigest: active.activationDigest,
      });
    }
  }

  const observationQualifications: {
    checkName: string;
    providerCheckUri: string;
    observationDigest: string;
    activationDigest: string;
  }[] = [];
  for (const dependency of check.checkDependencies) {
    if (dependency.observationDigest === undefined) return undefined;
    const active = activeQualifications.get(dependency.providerCheckUri);
    if (!active) return undefined;
    observationQualifications.push({
      checkName: dependency.checkName,
      providerCheckUri: dependency.providerCheckUri,
      observationDigest: dependency.observationDigest,
      activationDigest: active.activationDigest,
    });
  }

  return canonicalDigest({
    schema: "trust.current-check-context@1",
    actionInput: check.actionInput,
    declarationQualifications,
    scenarioQualifications: scenarioQualifications.sort(
      (left, right) =>
        left.scenario.localeCompare(right.scenario)
        || left.checkUri.localeCompare(right.checkUri),
    ),
    observationQualifications: observationQualifications.sort(
      (left, right) =>
        left.checkName.localeCompare(right.checkName)
        || left.providerCheckUri.localeCompare(right.providerCheckUri),
    ),
  });
}

/**
 * Rebuilds the current materialization state after one Check is observed again.
 * Historical Facts and Snapshots are untouched; only the providers selected by
 * the caller are removed before the current validated batch is projected.
 */
export function replaceValidatedFactBatch(
  current: MaterializedPlanRevision,
  batch: ValidatedFactBatch | undefined,
  replacedProviderCheckUris: ReadonlySet<string>,
): PlanMaterializationState {
  const roleIncarnations = current.roleIncarnations
    .filter((incarnation) => !replacedProviderCheckUris.has(incarnation.providerCheckUri));
  for (const incarnation of batch?.roleIncarnations ?? []) {
    const exact = roleIncarnations.some(
      (candidate) => canonicalJson(candidate) === canonicalJson(incarnation),
    );
    if (exact) continue;

    const contract = materializationContractFor(current, incarnation);
    if (contract.cardinality === "one") {
      const conflict = roleIncarnations.find(
        (candidate) =>
          candidate.role === incarnation.role
          && canonicalJson(candidate.parents) === canonicalJson(incarnation.parents),
      );
      if (conflict) {
        throw new TypeError(
          `role ${incarnation.role} already has one different incarnation at the same parents`,
        );
      }
    }
    roleIncarnations.push(cloneRoleIncarnation(incarnation));
  }

  const validatedOutputs = current.validatedOutputs
    .filter((projection) => !replacedProviderCheckUris.has(projection.providerCheckUri));
  for (const projection of batch?.validatedOutputs ?? []) {
    const existing = validatedOutputs.find(
      (candidate) =>
        candidate.providerCheckUri === projection.providerCheckUri
        && candidate.output === projection.output,
    );
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(projection)) continue;
      throw new TypeError(
        `validated output ${projection.output} for ${projection.providerCheckUri} conflicts with its recorded projection`,
      );
    }
    validatedOutputs.push(cloneOutputProjection(projection));
  }

  const validatedCheckObservations = current.validatedCheckObservations
    .filter((projection) => !replacedProviderCheckUris.has(projection.providerCheckUri));
  for (const projection of batch?.validatedCheckObservations ?? []) {
    const existing = validatedCheckObservations.find(
      (candidate) => candidate.providerCheckUri === projection.providerCheckUri,
    );
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(projection)) continue;
      throw new TypeError(`validated Check observations for ${projection.providerCheckUri} conflict with their recorded projection`);
    }
    validatedCheckObservations.push(cloneCheckObservationProjection(projection));
  }

  return Object.freeze({
    roleIncarnations: Object.freeze(roleIncarnations.sort(compareCanonical)),
    validatedOutputs: Object.freeze(validatedOutputs.sort(compareCanonical)),
    validatedCheckObservations: Object.freeze(validatedCheckObservations.sort(compareCanonical)),
  });
}

type MaterializedCheckDraft = Omit<MaterializedCheck, "compiledCheckDigest">;

interface ContextIncarnation {
  readonly role: string;
  readonly value: unknown;
  readonly parents: RuntimeJsonObject;
}

interface TargetBinding {
  readonly actionInput: RuntimeJsonObject;
  readonly expansion: readonly string[];
}

function compileMaterializationContract(
  template: CompiledAutonomousCheck,
  roles: readonly CompiledAutonomousResourceRole[],
): readonly MaterializationOutputContract[] {
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  return Object.freeze(template.materializes.map((materialization) => {
    const { output, role: roleName } = materialization;
    const role = roleByName.get(roleName);
    if (
      !role
      || role.materialization.kind !== "capability-output"
      || role.materialization.output !== output
      || !role.materialization.providers.some((provider) => sameProvider(provider, template.ref))
    ) {
      throw new TypeError(
        `compiled output ${output} does not own materialized role ${roleName}`,
      );
    }
    return Object.freeze({
      output,
      observation: materialization.observation,
      role: roleName,
      valueType: role.valueType,
      sourceCardinality: materialization.sourceCardinality,
      cardinality: materialization.cardinality,
      parents: Object.freeze(materialization.parents.map((parent) => {
        const parentRole = roleByName.get(parent.role);
        if (!parentRole) {
          throw new TypeError(
            `materialized role ${roleName} refers to unknown parent ${parent.role}`,
          );
        }
        return Object.freeze({
          kind: parent.kind,
          port: parent.port,
          role: parent.role,
          each: parent.each,
          valueType: parentRole.valueType,
        });
      })),
    });
  }));
}

function resolveCheckDependencies(
  consumer: MaterializedCheckDraft,
  checks: readonly MaterializedCheckDraft[],
  projections: readonly ValidatedCheckObservationProjection[],
): MaterializedCheck["checkDependencies"] | undefined {
  const dependencies = new Map<string, MaterializedCheck["checkDependencies"][number]>();
  for (const predicate of consumer.template.qualification.predicates) {
    const expectation = predicate.expectation;
    if (expectation.kind !== "check-observation") continue;
    const providers = checks.filter((candidate) =>
      sameProvider(candidate.template.ref, expectation.provider)
    );
    if (providers.length === 0) return undefined;
    if (providers.length !== 1 || !providers[0]) {
      throw new TypeError(
        `Check ${expectation.check} must resolve to exactly one materialized provider Check`,
      );
    }
    const provider = providers[0];
    const active = projections.filter(
      (projection) => projection.checkName === expectation.check && projection.providerCheckUri === provider.uri,
    );
    if (active.length > 1) {
      throw new TypeError(
        `Check ${expectation.check} has more than one active observation projection for ${provider.uri}`,
      );
    }
    const projection = active[0];
    dependencies.set(`${expectation.check}\0${provider.uri}`, {
      checkName: expectation.check,
      providerCheckUri: provider.uri,
      ...(projection ? { observationDigest: canonicalDigest(projection) } : {}),
    });
  }
  return Object.freeze([...dependencies.values()].sort(compareCanonical));
}

function materializationContractFor(
  revision: MaterializedPlanRevision,
  incarnation: MaterializedRoleIncarnation,
): MaterializationOutputContract {
  const provider = revision.checks.find(
    (check) => check.uri === incarnation.providerCheckUri,
  );
  const contract = provider?.materializationContract.find(
    (candidate) =>
      candidate.output === incarnation.output
      && candidate.role === incarnation.role
      && sameProvider(provider.template.ref, incarnation.provider),
  );
  if (!contract) {
    throw new TypeError(
      `Check ${incarnation.providerCheckUri} cannot materialize ${incarnation.output}`,
    );
  }
  return contract;
}

function validateRootInputs(
  roles: readonly CompiledAutonomousResourceRole[],
  value: RuntimeJsonObject,
): RuntimeJsonObject {
  if (!isPlainObject(value)) {
    throw new TypeError("Plan rootInputs must be one JSON object");
  }
  const expected = roles.filter((role) => role.materialization.kind === "plan-input");
  const expectedNames = new Set(expected.map((role) => role.name));
  const actualNames = Object.keys(value);
  if (
    actualNames.length !== expectedNames.size
    || actualNames.some((name) => !expectedNames.has(name))
  ) {
    throw new TypeError(
      `Plan rootInputs must contain exactly: ${[...expectedNames].sort().join(", ")}`,
    );
  }
  const normalized: Record<string, unknown> = {};
  for (const role of expected.filter((candidate) => !candidate.parents.some((parent) => parent.each))) {
    const candidate = value[role.name];
    assertRoleValue(role.name, candidate, role.valueType, role.cardinality);
    normalized[role.name] = cloneJson(candidate);
  }
  for (const role of expected.filter((candidate) => candidate.parents.some((parent) => parent.each))) {
    const candidate = value[role.name];
    if (!Array.isArray(candidate)) {
      throw new TypeError(`Plan correlated root input ${role.name} must be an array of coordinated values`);
    }
    const expectedParents = role.parents.filter((parent) => parent.each);
    if (expectedParents.length !== 1) {
      throw new TypeError(`Plan correlated root input ${role.name} must have one each parent`);
    }
    const parent = expectedParents[0];
    if (!parent) throw new TypeError(`Plan correlated root input ${role.name} has no parent`);
    const parentRaw = normalized[parent.role];
    const parentValues = Array.isArray(parentRaw) ? parentRaw : [parentRaw];
    const entries = candidate.map((entry, index) => validateCorrelatedRootValue(
      role,
      parent.role,
      entry,
      index,
    ));
    if (entries.length !== parentValues.length) {
      throw new TypeError(`Plan correlated root input ${role.name} must contain one value per ${parent.role}`);
    }
    for (const parentValue of parentValues) {
      const matches = entries.filter((entry) =>
        canonicalJson(entry.parents[0]?.value) === canonicalJson(parentValue)
      );
      if (matches.length !== 1) {
        throw new TypeError(`Plan correlated root input ${role.name} must contain one value per ${parent.role}`);
      }
    }
    normalized[role.name] = Object.freeze(entries.sort(compareCanonical));
  }
  return Object.freeze(normalized);
}

/**
 * Validates the complete current snapshot of roles the Feature explicitly lets
 * the agent declare. Missing roles are simply not declared yet; unknown roles,
 * partial correlations and duplicate values are rejected.
 */
export function validateAgentDeclarations(
  roles: readonly CompiledAutonomousResourceRole[],
  rootInputs: RuntimeJsonObject,
  value: RuntimeJsonObject,
): RuntimeJsonObject {
  if (!isPlainObject(value)) {
    throw new TypeError("Plan agentDeclarations must be one JSON object");
  }
  const allowed = new Set(
    roles
      .filter((role) => role.materialization.kind === "agent-declaration")
      .map((role) => role.name),
  );
  const actualNames = Object.keys(value);
  const unknown = actualNames.find((name) => !allowed.has(name));
  if (unknown !== undefined) {
    throw new TypeError(`Role ${unknown} is not declared by the Feature as agent-owned`);
  }

  const normalized: Record<string, unknown> = {};
  const context = basePlanContext(roles, rootInputs);
  const byName = new Map(roles.map((role) => [role.name, role]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const append = (role: CompiledAutonomousResourceRole): void => {
    if (visited.has(role.name)) return;
    if (visiting.has(role.name)) {
      throw new TypeError(`Agent declaration role cycle includes ${role.name}`);
    }
    visiting.add(role.name);
    for (const parent of role.parents) {
      const parentRole = byName.get(parent.role);
      if (parentRole?.materialization.kind === "agent-declaration") append(parentRole);
    }
    visiting.delete(role.name);
    visited.add(role.name);
    if (!Object.hasOwn(value, role.name)) return;

    const raw = value[role.name];
    const eachParents = role.parents.filter((parent) => parent.each);
    if (eachParents.length > 0) {
      if (!Array.isArray(raw) || eachParents.length !== 1) {
        throw new TypeError(
          `Agent declaration ${role.name} must be an array with one coordinated parent`,
        );
      }
      const parent = eachParents[0];
      if (!parent) throw new TypeError(`Agent declaration ${role.name} has no parent`);
      const parentValues = context
        .filter((candidate) => candidate.role === parent.role)
        .map((candidate) => candidate.value);
      if (parentValues.length === 0) {
        throw new TypeError(
          `Agent declaration ${role.name} requires current parent ${parent.role}`,
        );
      }
      const entries = raw.map((entry, index) => validateCorrelatedRootValue(
        role,
        parent.role,
        entry,
        index,
      ));
      if (entries.length !== parentValues.length) {
        throw new TypeError(
          `Agent declaration ${role.name} must contain one value per ${parent.role}`,
        );
      }
      for (const parentValue of parentValues) {
        const matches = entries.filter(
          (entry) => canonicalJson(entry.parents[0]?.value) === canonicalJson(parentValue),
        );
        if (matches.length !== 1) {
          throw new TypeError(
            `Agent declaration ${role.name} must contain one value per ${parent.role}`,
          );
        }
      }
      const sorted = Object.freeze(entries.sort(compareCanonical));
      normalized[role.name] = sorted;
      appendContextValues(role, sorted, context);
      return;
    }

    assertRoleValue(role.name, raw, role.valueType, role.cardinality);
    if (
      Array.isArray(raw)
      && uniqueValues(raw).length !== raw.length
    ) {
      throw new TypeError(`Agent declaration ${role.name} contains a duplicate value`);
    }
    const cloned = cloneJson(raw);
    normalized[role.name] = cloned;
    appendContextValues(role, cloned, context);
  };
  for (const role of roles) {
    if (role.materialization.kind === "agent-declaration") append(role);
  }
  return Object.freeze(normalized);
}

function validateAgentDeclarationActivations(
  roles: readonly CompiledAutonomousResourceRole[],
  declarations: RuntimeJsonObject,
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!isPlainObject(value)) {
    throw new TypeError("Plan agentDeclarationActivations must be one JSON object");
  }
  const declaredRoles = new Set(
    roles
      .filter((role) => role.materialization.kind === "agent-declaration")
      .map((role) => role.name),
  );
  const expected = Object.keys(declarations).sort();
  const actual = Object.keys(value).sort();
  if (
    canonicalJson(expected) !== canonicalJson(actual)
    || actual.some((role) => !declaredRoles.has(role) || typeof value[role] !== "string")
  ) {
    throw new TypeError(
      "Agent declaration activations must match the current declared roles exactly",
    );
  }
  return Object.freeze(Object.fromEntries(actual.map((role) => [role, value[role] as string])));
}

function validateCorrelatedRootValue(
  role: CompiledAutonomousResourceRole,
  parentRole: string,
  raw: unknown,
  index: number,
): { readonly value: unknown; readonly parents: readonly { readonly role: string; readonly value: unknown }[] } {
  if (!isPlainObject(raw) || canonicalJson(Object.keys(raw).sort()) !== canonicalJson(["parents", "value"])) {
    throw new TypeError(`Plan correlated root input ${role.name}[${index}] must contain value and parents`);
  }
  assertScalarValue(role.name, raw.value, role.valueType);
  if (!Array.isArray(raw.parents) || raw.parents.length !== 1) {
    throw new TypeError(`Plan correlated root input ${role.name}[${index}] must contain one parent coordinate`);
  }
  const parent = raw.parents[0];
  if (
    !isPlainObject(parent)
    || canonicalJson(Object.keys(parent).sort()) !== canonicalJson(["role", "value"])
    || parent.role !== parentRole
  ) {
    throw new TypeError(`Plan correlated root input ${role.name}[${index}] has another parent role`);
  }
  return Object.freeze({
    value: cloneJson(raw.value),
    parents: Object.freeze([{ role: parentRole, value: cloneJson(parent.value) }]),
  });
}

function validateMaterializationState(
  roles: readonly CompiledAutonomousResourceRole[],
  state: PlanMaterializationState,
): PlanMaterializationState {
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  const roleIncarnations = state.roleIncarnations.map((incarnation) => {
    const role = roleByName.get(incarnation.role);
    if (
      !role
      || role.materialization.kind !== "capability-output"
      || role.materialization.output !== incarnation.output
      || !role.materialization.providers.some(
        (provider) => sameProvider(provider, incarnation.provider),
      )
    ) {
      throw new TypeError(
        `materialization state contains an invalid incarnation for role ${incarnation.role}`,
      );
    }
    assertScalarValue(incarnation.role, incarnation.value, role.valueType);
    assertExactParentShape(role, incarnation.parents, roleByName);
    return cloneRoleIncarnation(incarnation);
  });
  const validatedOutputs = state.validatedOutputs.map(cloneOutputProjection);
  const validatedCheckObservations = state.validatedCheckObservations.map(cloneCheckObservationProjection);
  return Object.freeze({
    roleIncarnations: Object.freeze(roleIncarnations.sort(compareCanonical)),
    validatedOutputs: Object.freeze(validatedOutputs.sort(compareCanonical)),
    validatedCheckObservations: Object.freeze(validatedCheckObservations.sort(compareCanonical)),
  });
}

function materializationContext(
  roles: readonly CompiledAutonomousResourceRole[],
  rootInputs: RuntimeJsonObject,
  agentDeclarations: RuntimeJsonObject,
  state: PlanMaterializationState,
): readonly ContextIncarnation[] {
  const context = basePlanContext(roles, rootInputs);
  for (const role of roles) {
    if (
      role.materialization.kind === "agent-declaration"
      && Object.hasOwn(agentDeclarations, role.name)
    ) appendContextValues(role, agentDeclarations[role.name], context);
  }
  for (const incarnation of state.roleIncarnations) {
    context.push(Object.freeze({
      role: incarnation.role,
      value: cloneJson(incarnation.value),
      parents: cloneObject(incarnation.parents),
    }));
  }
  for (const incarnation of context) {
    for (const [parentRole, parentValue] of Object.entries(incarnation.parents)) {
      if (!context.some(
        (candidate) =>
          candidate.role === parentRole
          && canonicalJson(candidate.value) === canonicalJson(parentValue),
      )) {
        throw new TypeError(
          `role ${incarnation.role} is correlated to unavailable parent ${parentRole}`,
        );
      }
    }
  }
  return Object.freeze(context.sort(compareCanonical));
}

function basePlanContext(
  roles: readonly CompiledAutonomousResourceRole[],
  rootInputs: RuntimeJsonObject,
): ContextIncarnation[] {
  const context: ContextIncarnation[] = [];
  for (const role of roles) {
    if (role.materialization.kind === "plan-input") {
      appendContextValues(role, rootInputs[role.name], context);
    } else if (role.materialization.kind === "static") {
      context.push(Object.freeze({
        role: role.name,
        value: role.materialization.value,
        parents: Object.freeze({}),
      }));
    }
  }
  return context;
}

function appendContextValues(
  role: CompiledAutonomousResourceRole,
  raw: unknown,
  context: ContextIncarnation[],
): void {
  const correlated = role.parents.some((parent) => parent.each);
  if (correlated) {
    const values = raw as readonly {
      readonly value: unknown;
      readonly parents: readonly { readonly role: string; readonly value: unknown }[];
    }[];
    for (const entry of values) {
      context.push(Object.freeze({
        role: role.name,
        value: cloneJson(entry.value),
        parents: Object.freeze(Object.fromEntries(entry.parents.map((parent) => [
          parent.role,
          cloneJson(parent.value),
        ]))),
      }));
    }
    return;
  }
  const values = role.cardinality === "many" ? raw as readonly unknown[] : [raw];
  const parents = inferredRootParents(role, context);
  for (const value of values) {
    context.push(Object.freeze({
      role: role.name,
      value: cloneJson(value),
      parents,
    }));
  }
}

function inferredRootParents(
  role: CompiledAutonomousResourceRole,
  context: readonly ContextIncarnation[],
): RuntimeJsonObject {
  const parents: Record<string, unknown> = {};
  for (const parent of role.parents) {
    const values = context
      .filter((candidate) => candidate.role === parent.role)
      .map((candidate) => candidate.value);
    const unique = uniqueValues(values);
    if (unique.length !== 1) {
      throw new TypeError(
        `Plan root input ${role.name} cannot infer one parent ${parent.role}`,
      );
    }
    parents[parent.role] = cloneJson(unique[0]);
  }
  return Object.freeze(parents);
}

function targetBindings(
  template: CompiledAutonomousCheck,
  contract: CompiledAutonomousProcedureDefinition["requiredCapabilities"][number]["contract"],
  roles: readonly CompiledAutonomousResourceRole[],
  context: readonly ContextIncarnation[],
): readonly TargetBinding[] {
  const target = template.uriTemplate.target;
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  const primaryRole = roleByName.get(target.primary.role);
  const primaryIncarnations = context.filter(
    (candidate) => candidate.role === target.primary.role,
  );
  if (!primaryRole || primaryIncarnations.length === 0) return [];

  const primaryGroups: readonly (readonly ContextIncarnation[])[] =
    target.primary.selection === "each"
      ? primaryIncarnations.map((candidate) => [candidate])
      : target.primary.selection === "all"
        ? [primaryIncarnations]
        : primaryIncarnations.length === 1
          ? [[primaryIncarnations[0] as ContextIncarnation]]
          : invalidTarget(
              target.primary.role,
              "one unambiguous materialized incarnation",
            );

  const bindings: TargetBinding[] = [];
  for (const selectedPrimary of primaryGroups) {
    const primaryValue = target.primary.selection === "all"
      ? selectedPrimary.map((candidate) => cloneJson(candidate.value))
      : cloneJson(selectedPrimary[0]?.value);
    const roleInput: Record<string, unknown> = {
      [target.primary.role]: primaryValue,
    };
    let complete = true;
    for (const use of target.using) {
      const candidates = context.filter((candidate) => candidate.role === use.role);
      if (candidates.length === 0) {
        complete = false;
        break;
      }
      if (use.selection === "all") {
        const related = rolesTopologicallyRelated(use.role, target.primary.role, roleByName)
          ? candidates.filter((candidate) =>
              selectedPrimary.some((primary) =>
                incarnationsRelated(primary, candidate, context),
              ))
          : candidates;
        if (related.length === 0) {
          complete = false;
          break;
        }
        roleInput[use.role] = related.map((candidate) => cloneJson(candidate.value));
        continue;
      }

      const related = candidates.filter((candidate) =>
        selectedPrimary.every((primary) =>
          incarnationsRelated(primary, candidate, context),
        )
      );
      const selected = related.length === 1
        ? related[0]
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      if (!selected) {
        complete = false;
        break;
      }
      roleInput[use.role] = cloneJson(selected.value);
    }
    if (!complete) continue;

    const semanticExpansion =
      target.primary.selection === "each"
      || (target.primary.selection === "one"
        && (primaryRole.materialization.kind === "static"
          || primaryRole.materialization.kind === "capability-output"));
    const actionInput = Object.fromEntries(template.inputBindings.map((binding) => {
      const inputContract = contract.inputs[binding.input];
      if (!inputContract || inputContract.parents.length === 0) {
        return [binding.input, cloneJson(roleInput[binding.role])];
      }
      const expectedByPort = actionInputParentValues(
        inputContract.parents,
        template,
        roleInput,
      );
      const childCandidates = context.filter(
        (candidate) => candidate.role === binding.role
          && inputContract.parents.every((parent) => {
            if (parent.kind !== "input") return false;
            const parentBinding = template.inputBindings.find((item) => item.input === parent.port);
            const actual = parentBinding ? candidate.parents[parentBinding.role] : undefined;
            return actual !== undefined && (expectedByPort[parent.port] ?? []).some(
              (expected) => canonicalJson(expected) === canonicalJson(actual),
            );
          }),
      );
      const values = childCandidates.map((candidate) => {
        const parents = inputContract.parents.map((parent) => {
          if (parent.kind !== "input") {
            throw new TypeError(`correlated input ${binding.input} has a non-input parent`);
          }
          const parentBinding = template.inputBindings.find((item) => item.input === parent.port);
          const parentValue = parentBinding === undefined
            ? undefined
            : candidate.parents[parentBinding.role];
          if (parentBinding === undefined || parentValue === undefined) {
            throw new TypeError(
              `correlated input ${binding.input} cannot resolve parent input ${parent.port}`,
            );
          }
          return Object.freeze({ kind: "input" as const, port: parent.port, value: cloneJson(parentValue) });
        });
        return Object.freeze({ value: cloneJson(candidate.value), parents: Object.freeze(parents) });
      }).sort(compareCanonical);
      assertCompleteCorrelatedInput(binding.input, inputContract.parents, values, expectedByPort);
      return [binding.input, Object.freeze(values)];
    }));
    bindings.push(Object.freeze({
      actionInput: Object.freeze(actionInput),
      expansion: semanticExpansion ? [semanticExpansionValue(primaryValue)] : [],
    }));
  }
  return Object.freeze(bindings);
}

function actionInputParentValues(
  parents: readonly { readonly kind: "input" | "observation"; readonly port: string }[],
  template: CompiledAutonomousCheck,
  roleInput: Readonly<Record<string, unknown>>,
): Readonly<Record<string, readonly unknown[]>> {
  return Object.freeze(Object.fromEntries(parents.map((parent) => {
    if (parent.kind !== "input") throw new TypeError("input correlation parent must be an input");
    const binding = template.inputBindings.find((candidate) => candidate.input === parent.port);
    if (!binding) throw new TypeError(`correlated parent input ${parent.port} is not bound`);
    const value = roleInput[binding.role];
    return [parent.port, Object.freeze(Array.isArray(value) ? [...value] : [value])];
  })));
}

function assertCompleteCorrelatedInput(
  input: string,
  parents: readonly { readonly kind: "input" | "observation"; readonly port: string }[],
  values: readonly { readonly value: unknown; readonly parents: readonly { readonly kind: string; readonly port: string; readonly value: unknown }[] }[],
  expectedByPort: Readonly<Record<string, readonly unknown[]>>,
): void {
  for (const parent of parents) {
    const expected = uniqueValues(expectedByPort[parent.port] ?? []);
    if (parents.length === 1 && values.length !== expected.length) {
      throw new TypeError(
        `correlated input ${input} must resolve exactly one value for each ${parent.kind} ${parent.port}`,
      );
    }
    for (const parentValue of expected) {
      const matches = values.filter((candidate) => candidate.parents.some(
        (coordinate) => coordinate.kind === parent.kind
          && coordinate.port === parent.port
          && canonicalJson(coordinate.value) === canonicalJson(parentValue),
      ));
      if (matches.length !== 1) {
        throw new TypeError(
          `correlated input ${input} must resolve exactly one value for each ${parent.kind} ${parent.port}`,
        );
      }
    }
  }
}

function incarnationsRelated(
  left: ContextIncarnation,
  right: ContextIncarnation,
  context: readonly ContextIncarnation[],
): boolean {
  if (left.role === right.role) {
    return canonicalJson(left.value) === canonicalJson(right.value);
  }
  if (hasAncestor(left, right, context) || hasAncestor(right, left, context)) return true;
  const sharedParents = Object.keys(left.parents).filter((role) => role in right.parents);
  return sharedParents.some(
    (role) => canonicalJson(left.parents[role]) === canonicalJson(right.parents[role]),
  );
}

function hasAncestor(
  descendant: ContextIncarnation,
  ancestor: ContextIncarnation,
  context: readonly ContextIncarnation[],
  visited: ReadonlySet<string> = new Set(),
): boolean {
  const key = `${descendant.role}:${canonicalJson(descendant.value)}`;
  if (visited.has(key)) return false;
  const nextVisited = new Set(visited).add(key);
  const direct = descendant.parents[ancestor.role];
  if (direct !== undefined && canonicalJson(direct) === canonicalJson(ancestor.value)) {
    return true;
  }
  return Object.entries(descendant.parents).some(([role, value]) =>
    context
      .filter(
        (candidate) =>
          candidate.role === role
          && canonicalJson(candidate.value) === canonicalJson(value),
      )
      .some((candidate) => hasAncestor(candidate, ancestor, context, nextVisited)),
  );
}

function rolesTopologicallyRelated(
  left: string,
  right: string,
  roles: ReadonlyMap<string, CompiledAutonomousResourceRole>,
): boolean {
  const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return (roles.get(from)?.parents ?? []).some(
      (parent) => reaches(parent.role, target, new Set(visited)),
    );
  };
  return reaches(left, right) || reaches(right, left);
}

function semanticExpansionValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("a Check URI expansion must resolve to one semantic string identifier");
  }
  return value;
}

function semanticCheckRepresentation(
  check: Omit<MaterializedCheck, "compiledCheckDigest">,
): unknown {
  const { planRevision: _planRevision, ...semantic } = check;
  return semantic;
}

function assertRoleValue(
  role: string,
  value: unknown,
  type: ActionContractValueType,
  cardinality: "one" | "many",
): void {
  const values = cardinality === "many"
    ? Array.isArray(value) && value.length > 0
      ? value
      : invalidRole(role, "a non-empty array")
    : Array.isArray(value)
      ? invalidRole(role, "one value")
      : [value];
  for (const candidate of values) assertScalarValue(role, candidate, type);
}

function assertScalarValue(
  role: string,
  value: unknown,
  type: ActionContractValueType,
): void {
  const valid =
    (type === "number" && typeof value === "number" && Number.isFinite(value))
    || ((type === "string" || type === "reference") && typeof value === "string")
    || (type === "instant" && isRfc3339Instant(value));
  if (!valid) invalidRole(role, type);
}

function assertExactParentShape(
  role: CompiledAutonomousResourceRole,
  parents: RuntimeJsonObject,
  roleByName: ReadonlyMap<string, CompiledAutonomousResourceRole>,
): void {
  if (!isPlainObject(parents)) {
    throw new TypeError(`role ${role.name} parents must be one object`);
  }
  const expected = new Set(role.parents.map((parent) => parent.role));
  const actual = Object.keys(parents);
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) {
    throw new TypeError(
      `role ${role.name} parents must contain exactly: ${[...expected].sort().join(", ")}`,
    );
  }
  for (const parent of role.parents) {
    const parentRole = roleByName.get(parent.role);
    if (!parentRole) throw new TypeError(`unknown parent role ${parent.role}`);
    assertScalarValue(parent.role, parents[parent.role], parentRole.valueType);
  }
}

function invalidRole(role: string, expectation: string): never {
  throw new TypeError(`Plan role ${role} must be ${expectation}`);
}

function invalidTarget(role: string, expectation: string): never {
  throw new TypeError(`Check target ${role} must resolve to ${expectation}`);
}

function cloneRoleIncarnation(
  value: MaterializedRoleIncarnation,
): MaterializedRoleIncarnation {
  return Object.freeze({
    output: value.output,
    role: value.role,
    value: cloneJson(value.value),
    parents: cloneObject(value.parents),
    provider: cloneProvider(value.provider),
    providerCheckUri: value.providerCheckUri,
  });
}

function cloneOutputProjection(
  value: ValidatedOutputProjection,
): ValidatedOutputProjection {
  if (!isPlainObject(value.values)) {
    throw new TypeError(`validated output ${value.output} values must be one object`);
  }
  return Object.freeze({
    output: value.output,
    provider: cloneProvider(value.provider),
    providerCheckUri: value.providerCheckUri,
    values: cloneObject(value.values),
  });
}

function cloneCheckObservationProjection(
  value: ValidatedCheckObservationProjection,
): ValidatedCheckObservationProjection {
  if (!isPlainObject(value.observations)) {
    throw new TypeError(`validated Check ${value.checkName} observations must be one object`);
  }
  return Object.freeze({
    checkName: value.checkName,
    provider: cloneProvider(value.provider),
    providerCheckUri: value.providerCheckUri,
    observations: cloneObject(value.observations),
  });
}

function cloneProvider(value: CompiledCapabilityCheckRef): CompiledCapabilityCheckRef {
  return cloneJson(value);
}

function cloneObject(value: RuntimeJsonObject): RuntimeJsonObject {
  return Object.freeze(cloneJson(value));
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (error) {
    throw new TypeError("Plan inputs and materialized values must contain JSON values", {
      cause: error,
    });
  }
}

function uniqueValues(values: readonly unknown[]): readonly unknown[] {
  const unique = new Map(values.map((value) => [canonicalJson(value), value]));
  return [...unique.values()];
}

function sameProvider(
  left: CompiledCapabilityCheckRef,
  right: CompiledCapabilityCheckRef,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
