import { createHash } from "node:crypto";

import type {
  CompiledProcedure,
  CompiledProcedureRole,
} from "@trust/procedure";

import { buildSemanticCheckUri } from "../check/uri.js";
import type {
  CheckValues,
  PlanCheck,
  PlanMode,
  PlanRevision,
  ProducedRoleValue,
  RuntimeJsonObject,
} from "../model.js";

interface ContextValue {
  readonly role: string;
  readonly value: unknown;
  readonly parents: RuntimeJsonObject;
}

type DraftPlanCheck = Omit<PlanCheck, "compiledCheckDigest" | "currentContextDigest" | "checkDependencies">;

export interface BuildPlanRevisionInput {
  readonly authority: string;
  readonly procedure: CompiledProcedure;
  readonly plan: string;
  readonly environment: string;
  readonly mode: PlanMode;
  readonly rootInputs: RuntimeJsonObject;
  readonly declarations?: RuntimeJsonObject;
  readonly revision: number;
  readonly roleValues?: readonly ProducedRoleValue[];
  readonly checkValues?: readonly CheckValues[];
  readonly pruneUnavailableRoleValues?: boolean;
}

export function buildPlanRevision(input: BuildPlanRevisionInput): PlanRevision {
  const rootInputs = validateRootInputs(input.procedure.roles, input.rootInputs);
  const { declarations, context: declaredContext } = normalizeDeclarations(
    input.procedure.roles,
    rootInputs,
    input.plan,
    input.declarations ?? Object.freeze({}),
  );
  const roleValues = input.roleValues ?? Object.freeze([]);
  const checkValues = input.checkValues ?? Object.freeze([]);
  const produced = appendProducedValues(
    input.procedure.roles,
    declaredContext,
    roleValues,
    input.pruneUnavailableRoleValues === true,
  );
  const context = produced.context;
  const scenarioDependencies = new Map(
    input.procedure.scenarios.map((scenario) => [scenario.slug, scenario.dependencies]),
  );
  const operationByName = new Map(
    input.procedure.operations.map((operation) => [operation.operation, operation]),
  );
  const checks: DraftPlanCheck[] = [];

  for (const compiledCheck of input.procedure.checks) {
    const operation = operationByName.get(compiledCheck.operation);
    if (
      !operation
      || operation.digest !== compiledCheck.operationDigest
      || operation.version !== compiledCheck.operationVersion
    ) {
      throw new TypeError(`Check "${compiledCheck.name}" has no exact embedded Operation`);
    }
    const targetValues = context.filter((candidate) => candidate.role === compiledCheck.target.role);
    const targets = targetGroups(targetValues, compiledCheck.target.selection);
    for (const selectedTarget of targets) {
      const actionInput = resolveActionInput(compiledCheck, selectedTarget, context);
      if (!actionInput) continue;
      const targetValue = compiledCheck.target.selection === "all"
        ? selectedTarget.map((candidate) => cloneJson(candidate.value))
        : cloneJson(selectedTarget[0]?.value);
      const scope = compiledCheck.target.selection === "all"
        ? Object.freeze({ role: compiledCheck.target.role, value: targetValue, parents: Object.freeze({}) })
        : Object.freeze({
            role: compiledCheck.target.role,
            value: targetValue,
            parents: cloneObject(selectedTarget[0]?.parents ?? {}),
          });
      const expansion = compiledCheck.target.selection === "each"
        ? [uriValue(targetValue)]
        : [];
      const uri = buildSemanticCheckUri({
        authority: input.authority,
        procedure: input.procedure.procedure,
        version: input.procedure.version,
        plan: input.plan,
        scenario: compiledCheck.scenario,
        check: compiledCheck.name,
        operation: compiledCheck.operation,
        ...(expansion.length === 0 ? {} : { expansion }),
      });
      const checkContext = contextForTarget(
        selectedTarget,
        context.filter((candidate) => {
          const role = input.procedure.roles.find((item) => item.name === candidate.role);
          return role?.source.kind !== "operation-field"
            || role.source.check !== compiledCheck.name;
        }),
      );
      const readsMissingOptionalDeclaration = compiledCheck.qualification.guards.some((guard) =>
        guard.references.some((reference) => {
          if (reference.kind !== "context" || Object.hasOwn(checkContext, reference.role)) return false;
          const role = input.procedure.roles.find((candidate) => candidate.name === reference.role);
          return role !== undefined && roleDependsOnOptionalDeclaration(role, input.procedure.roles);
        })
      );
      const materializesWithoutParent = compiledCheck.materializes.some((production) => {
        const role = input.procedure.roles.find((candidate) => candidate.name === production.role);
        return role?.parents.some((parent) => {
          if (Object.hasOwn(checkContext, parent.role)) return false;
          const parentRole = input.procedure.roles.find((candidate) => candidate.name === parent.role);
          return parentRole !== undefined && roleDependsOnOptionalDeclaration(parentRole, input.procedure.roles);
        }) ?? false;
      });
      if (readsMissingOptionalDeclaration || materializesWithoutParent) continue;
      checks.push({
        uri,
        planSlug: input.plan,
        planRevision: input.revision,
        scenario: compiledCheck.scenario,
        expansion,
        check: compiledCheck,
        operation: operation.definition,
        actionInput,
        context: checkContext,
        scope,
        scenarioDependencies: scenarioDependencies.get(compiledCheck.scenario) ?? [],
      });
    }
  }

  const availableChecks = retainChecksWithAvailableProviders(checks, input.procedure.roles, context);
  const byName = new Map<string, DraftPlanCheck[]>();
  for (const check of availableChecks) {
    const values = byName.get(check.check.name) ?? [];
    values.push(check);
    byName.set(check.check.name, values);
  }
  const withDependencies: PlanCheck[] = availableChecks.map((check) => {
    const checkDependencies = requiredCheckNames(check, input.procedure.roles)
      .flatMap((name) => relatedProviders(check, byName.get(name) ?? [], context)
        .map((provider) => ({ checkName: name, providerCheckUri: provider.uri })));
    const scenarioDependencyUris = check.scenarioDependencies.flatMap((scenario) => availableChecks
      .filter((candidate) => candidate.scenario === scenario)
      .map((candidate) => candidate.uri));
    // A Check identity contains only the context it consumes, plus the exact upstream Checks that
    // provide values or prerequisites. Unrelated downstream values do not reopen it.
    const consumed = consumedContext(check.check, input.procedure.roles, check.scope, check.context);
    return {
      ...check,
      compiledCheckDigest: digest({
        check: check.check,
        operationDigest: check.check.operationDigest,
        actionInput: check.actionInput,
        context: consumed,
        scope: check.scope,
        scenarioDependencyUris,
        checkDependencies,
      }),
      currentContextDigest: digest({
        actionInput: check.actionInput,
        context: consumed,
        scenarioDependencyUris,
        checkDependencies,
      }),
      checkDependencies,
    };
  });

  return Object.freeze({
    procedure: input.procedure.procedure,
    procedureVersion: input.procedure.version,
    environment: input.environment,
    mode: input.mode,
    intentChaining: input.procedure.intentChaining,
    rootInputs,
    agentDeclarations: declarations,
    planSlug: input.plan,
    revision: input.revision,
    definitionDigest: input.procedure.definitionDigest,
    source: input.procedure.source,
    checks: Object.freeze(withDependencies),
    roleValues: produced.roleValues,
    checkValues: Object.freeze([...checkValues]),
  });
}

export function validateAgentDeclarations(
  roles: readonly CompiledProcedureRole[],
  rootInputs: RuntimeJsonObject,
  plan: string,
  declarations: RuntimeJsonObject,
): RuntimeJsonObject {
  return normalizeDeclarations(roles, validateRootInputs(roles, rootInputs), plan, declarations).declarations;
}

function validateRootInputs(
  roles: readonly CompiledProcedureRole[],
  values: RuntimeJsonObject,
): RuntimeJsonObject {
  const expected = new Map(
    roles.filter((role) => role.source.kind === "plan-input").map((role) => [role.name, role]),
  );
  if (
    Object.keys(values).length !== expected.size
    || Object.keys(values).some((name) => !expected.has(name))
  ) {
    throw new TypeError(`Plan Inputs must be exactly: ${[...expected.keys()].join(", ")}`);
  }
  const normalized = cloneObject(values);
  const context: ContextValue[] = [];
  const appended = new Set<string>();
  const append = (role: CompiledProcedureRole): void => {
    if (appended.has(role.name)) return;
    for (const parent of role.parents) {
      const parentRole = roles.find((candidate) => candidate.name === parent.role);
      if (parentRole?.source.kind === "plan-input" || parentRole?.source.kind === "fixed") {
        append(parentRole);
      }
    }
    if (role.source.kind === "plan-input") {
      appendInputValues(role, normalized[role.name], context, "Plan Input");
    } else if (role.source.kind === "fixed") {
      appendInputValues(role, role.source.value, context, "fixed role");
    }
    appended.add(role.name);
  };
  for (const role of roles) {
    if (role.source.kind === "plan-input" || role.source.kind === "fixed") append(role);
  }
  return Object.freeze(normalized);
}

function normalizeDeclarations(
  roles: readonly CompiledProcedureRole[],
  roots: RuntimeJsonObject,
  plan: string,
  value: RuntimeJsonObject,
): { readonly declarations: RuntimeJsonObject; readonly context: readonly ContextValue[] } {
  const allowed = new Set(
    roles.filter((role) => role.source.kind === "agent-declaration").map((role) => role.name),
  );
  const unknown = Object.keys(value).find((name) => !allowed.has(name));
  if (unknown !== undefined) throw new TypeError(`Role "${unknown}" is not declared by the Procedure`);

  const context = baseContext(roles, roots, plan);
  const normalized: Record<string, unknown> = {};
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const append = (role: CompiledProcedureRole): void => {
    if (visited.has(role.name)) return;
    if (visiting.has(role.name)) throw new TypeError(`Agent declaration cycle includes "${role.name}"`);
    visiting.add(role.name);
    for (const parent of role.parents) {
      const parentRole = roles.find((candidate) => candidate.name === parent.role);
      if (parentRole?.source.kind === "agent-declaration") append(parentRole);
    }
    visiting.delete(role.name);
    visited.add(role.name);
    if (!Object.hasOwn(value, role.name)) return;
    normalized[role.name] = normalizeDeclaredValue(role, value[role.name], context);
    appendInputValues(role, normalized[role.name], context, "Agent declaration");
  };
  for (const role of roles) if (role.source.kind === "agent-declaration") append(role);
  return {
    declarations: Object.freeze(normalized),
    context: Object.freeze(context.sort(compareCanonical)),
  };
}

/** Root Plan Inputs, fixed roles and the Plan identifier: the context every Plan starts from. */
function baseContext(
  roles: readonly CompiledProcedureRole[],
  roots: RuntimeJsonObject,
  plan: string,
): ContextValue[] {
  const context: ContextValue[] = [];
  const appended = new Set<string>();
  const append = (role: CompiledProcedureRole): void => {
    if (appended.has(role.name)) return;
    for (const parent of role.parents) {
      const parentRole = roles.find((candidate) => candidate.name === parent.role);
      if (parentRole?.source.kind === "plan-input" || parentRole?.source.kind === "fixed") append(parentRole);
    }
    if (role.source.kind === "plan-input") appendInputValues(role, roots[role.name], context, "Plan Input");
    if (role.source.kind === "fixed") appendInputValues(role, role.source.value, context, "fixed role");
    if (role.source.kind === "plan-identifier") appendInputValues(role, plan, context, "Plan identifier");
    appended.add(role.name);
  };
  for (const role of roles) {
    if (role.source.kind === "plan-input" || role.source.kind === "fixed" || role.source.kind === "plan-identifier") append(role);
  }
  return context;
}

function normalizeDeclaredValue(
  role: CompiledProcedureRole,
  raw: unknown,
  context: readonly ContextValue[],
): unknown {
  const eachParents = role.parents.filter((parent) => parent.each);
  if (eachParents.length === 0) {
    validateRoleValue(role, raw);
    if (Array.isArray(raw) && uniqueValues(raw).length !== raw.length) {
      throw new TypeError(`Agent declaration "${role.name}" contains a duplicate value`);
    }
    return cloneJson(raw);
  }
  if (!Array.isArray(raw) || eachParents.length !== 1) {
    throw new TypeError(`Agent declaration "${role.name}" must contain coordinated values`);
  }
  const parent = eachParents[0];
  if (!parent) throw new TypeError(`Agent declaration "${role.name}" has no parent`);
  const parentValues = context.filter((candidate) => candidate.role === parent.role);
  const entries = raw.map((entry, index) => coordinatedValue(role, parent.role, entry, index));
  const entryCounts = parentValues.map((parentValue) =>
    entries.filter((entry) => same(entry.parents[0]?.value, parentValue.value)).length
  );
  const allParentsExist = entries.every((entry) =>
    parentValues.some((parentValue) => same(entry.parents[0]?.value, parentValue.value))
  );
  const validCounts = role.cardinality === "one"
    ? entryCounts.every((count) => count === 1)
    : entryCounts.every((count) => count >= 1);
  const uniqueCoordinates = new Set(entries.map((entry) => canonicalJson({
    value: entry.value,
    parent: entry.parents[0]?.value,
  })));
  if (!allParentsExist || !validCounts || uniqueCoordinates.size !== entries.length) {
    const expected = role.cardinality === "one" ? "one value" : "one or more unique values";
    throw new TypeError(`Agent declaration "${role.name}" must contain ${expected} per "${parent.role}"`);
  }
  return Object.freeze(entries.sort(compareCanonical));
}

function appendInputValues(
  role: CompiledProcedureRole,
  raw: unknown,
  context: ContextValue[],
  label: string,
): void {
  const eachParents = role.parents.filter((parent) => parent.each);
  if (eachParents.length > 0) {
    if (!Array.isArray(raw)) throw new TypeError(`${label} "${role.name}" must contain coordinated values`);
    const parent = eachParents[0];
    if (!parent) throw new TypeError(`${label} "${role.name}" has no parent`);
    for (const [index, item] of raw.entries()) {
      const entry = coordinatedValue(role, parent.role, item, index);
      context.push(Object.freeze({
        role: role.name,
        value: cloneJson(entry.value),
        parents: Object.freeze(Object.fromEntries(entry.parents.map((coordinate) => [
          coordinate.role,
          cloneJson(coordinate.value),
        ]))),
      }));
    }
    return;
  }
  validateRoleValue(role, raw);
  const values = role.cardinality === "many" ? raw as readonly unknown[] : [raw];
  const parents = inferredParents(role, context, label);
  for (const item of values) {
    context.push(Object.freeze({ role: role.name, value: cloneJson(item), parents }));
  }
}

function appendProducedValues(
  roles: readonly CompiledProcedureRole[],
  base: readonly ContextValue[],
  produced: readonly ProducedRoleValue[],
  pruneUnavailable: boolean,
): {
  readonly context: readonly ContextValue[];
  readonly roleValues: readonly ProducedRoleValue[];
} {
  const context = [...base];
  const retained: ProducedRoleValue[] = [];
  for (const item of produced) {
    const role = roles.find((candidate) => candidate.name === item.role);
    if (!role || role.source.kind !== "operation-field") {
      throw new TypeError(`Produced role "${item.role}" is not owned by an Operation`);
    }
    validateScalar(role, item.value);
    const expected = role.parents.map((parent) => parent.role).sort();
    const actual = Object.keys(item.parents).sort();
    if (!same(expected, actual)) throw new TypeError(`Produced role "${item.role}" has invalid parents`);
    const unavailableParent = Object.entries(item.parents).find(([parentRole, parentValue]) =>
      !context.some((candidate) => candidate.role === parentRole && same(candidate.value, parentValue))
    );
    if (unavailableParent) {
      if (pruneUnavailable) continue;
      throw new TypeError(`Produced role "${item.role}" refers to unavailable parent "${unavailableParent[0]}"`);
    }
    context.push(Object.freeze({ role: item.role, value: cloneJson(item.value), parents: cloneObject(item.parents) }));
    retained.push(item);
  }
  return Object.freeze({
    context: Object.freeze(context.sort(compareCanonical)),
    roleValues: Object.freeze([...retained]),
  });
}

function targetGroups(
  values: readonly ContextValue[],
  selection: "one" | "each" | "all",
): readonly (readonly ContextValue[])[] {
  if (values.length === 0) return [];
  if (selection === "each") return values.map((value) => [value]);
  if (selection === "all") return [values];
  return values.length === 1 ? [[values[0] as ContextValue]] : [];
}

function resolveActionInput(
  check: CompiledProcedure["checks"][number],
  selectedTarget: readonly ContextValue[],
  context: readonly ContextValue[],
): RuntimeJsonObject | undefined {
  const actionInput: Record<string, unknown> = {};
  for (const binding of check.inputBindings) {
    if (binding.role === check.target.role) {
      actionInput[binding.input] = check.target.selection === "all"
        ? selectedTarget.map((candidate) => cloneJson(candidate.value))
        : cloneJson(selectedTarget[0]?.value);
      continue;
    }
    const candidates = context.filter((candidate) => candidate.role === binding.role);
    if (candidates.length === 0) return undefined;
    const related = candidates.filter((candidate) =>
      selectedTarget.some((target) => contextValuesRelated(target, candidate, context))
    );
    if (binding.selection === "all") {
      const selected = related.length > 0
        ? related
        : candidates.every((candidate) => Object.keys(candidate.parents).length === 0)
          ? candidates
          : [];
      if (selected.length === 0) return undefined;
      actionInput[binding.input] = selected.map((candidate) => cloneJson(candidate.value));
      continue;
    }
    const selected = related.length === 1
      ? related[0]
      : candidates.length === 1 && Object.keys(candidates[0]!.parents).length === 0
        ? candidates[0]
        : undefined;
    if (!selected) return undefined;
    actionInput[binding.input] = cloneJson(selected.value);
  }
  return Object.freeze(actionInput);
}

/** Roles a Check depends on: its target and the target's lineage, the roles bound to its inputs,
    the roles referenced by its qualification, and the parents of the roles it materializes. */
function consumedContext(
  compiledCheck: CompiledProcedure["checks"][number],
  roles: readonly CompiledProcedureRole[],
  scope: PlanCheck["scope"],
  context: RuntimeJsonObject,
): RuntimeJsonObject {
  const names = new Set<string>([compiledCheck.target.role, ...Object.keys(scope.parents)]);
  for (const binding of compiledCheck.inputBindings) names.add(binding.role);
  for (const guard of compiledCheck.qualification.guards) {
    for (const reference of guard.references) {
      if (reference.kind === "context") names.add(reference.role);
    }
  }
  for (const production of compiledCheck.materializes) {
    const role = roles.find((candidate) => candidate.name === production.role);
    for (const parent of role?.parents ?? []) names.add(parent.role);
  }
  return Object.freeze(Object.fromEntries(Object.entries(context).filter(([name]) => names.has(name))));
}

function contextForTarget(
  targets: readonly ContextValue[],
  context: readonly ContextValue[],
): RuntimeJsonObject {
  const values: Record<string, unknown> = {};
  for (const role of new Set(context.map((candidate) => candidate.role))) {
    const candidates = context.filter((candidate) => candidate.role === role);
    const related = candidates.filter((candidate) =>
      targets.some((target) => contextValuesRelated(target, candidate, context))
    );
    const selected = related.length > 0
      ? related
      : candidates.length > 0 && candidates.every((candidate) => Object.keys(candidate.parents).length === 0)
        ? candidates
        : [];
    if (selected.length === 1) values[role] = cloneJson(selected[0]?.value);
    if (selected.length > 1) values[role] = selected.map((candidate) => cloneJson(candidate.value));
  }
  return Object.freeze(values);
}

function relatedProviders(
  check: DraftPlanCheck,
  providers: readonly DraftPlanCheck[],
  context: readonly ContextValue[],
): readonly DraftPlanCheck[] {
  if (providers.length <= 1) return providers;
  const current = contextValue(check.scope);
  const related = providers.filter((provider) =>
    contextValuesRelated(current, contextValue(provider.scope), context)
  );
  return related.length > 0 ? related : providers;
}

function contextValuesRelated(
  left: ContextValue,
  right: ContextValue,
  context: readonly ContextValue[],
): boolean {
  if (left.role === right.role) return same(left.value, right.value);
  if (hasAncestor(left, right, context) || hasAncestor(right, left, context)) return true;
  const shared = Object.keys(left.parents).filter((role) => Object.hasOwn(right.parents, role));
  return shared.some((role) => same(left.parents[role], right.parents[role]));
}

function hasAncestor(
  descendant: ContextValue,
  ancestor: ContextValue,
  context: readonly ContextValue[],
  visited: ReadonlySet<string> = new Set(),
): boolean {
  const key = `${descendant.role}:${canonicalJson(descendant.value)}`;
  if (visited.has(key)) return false;
  const next = new Set(visited).add(key);
  const direct = descendant.parents[ancestor.role];
  if (direct !== undefined && same(direct, ancestor.value)) return true;
  return Object.entries(descendant.parents).some(([role, value]) =>
    context.filter((candidate) => candidate.role === role && same(candidate.value, value))
      .some((candidate) => hasAncestor(candidate, ancestor, context, next))
  );
}

function inferredParents(
  role: CompiledProcedureRole,
  context: readonly ContextValue[],
  label: string,
): RuntimeJsonObject {
  const parents: Record<string, unknown> = {};
  for (const parent of role.parents) {
    const candidates = uniqueValues(
      context.filter((candidate) => candidate.role === parent.role).map((candidate) => candidate.value),
    );
    if (candidates.length !== 1) {
      throw new TypeError(`${label} "${role.name}" cannot infer parent "${parent.role}"`);
    }
    parents[parent.role] = cloneJson(candidates[0]);
  }
  return Object.freeze(parents);
}

function coordinatedValue(
  role: CompiledProcedureRole,
  parentRole: string,
  raw: unknown,
  index: number,
): { readonly value: unknown; readonly parents: readonly { readonly role: string; readonly value: unknown }[] } {
  if (!isRecord(raw) || !Object.hasOwn(raw, "value") || !Array.isArray(raw.parents)) {
    throw new TypeError(`Role "${role.name}" value ${index} must contain value and parents`);
  }
  validateScalar(role, raw.value);
  if (raw.parents.length !== 1 || !isRecord(raw.parents[0])
    || raw.parents[0].role !== parentRole || !Object.hasOwn(raw.parents[0], "value")) {
    throw new TypeError(`Role "${role.name}" value ${index} must identify parent "${parentRole}"`);
  }
  return Object.freeze({
    value: cloneJson(raw.value),
    parents: Object.freeze([{ role: parentRole, value: cloneJson(raw.parents[0].value) }]),
  });
}

function validateRoleValue(role: CompiledProcedureRole, value: unknown): void {
  if (role.cardinality === "many") {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError(`Role "${role.name}" must contain values`);
    for (const item of value) validateScalar(role, item);
    return;
  }
  if (Array.isArray(value)) throw new TypeError(`Role "${role.name}" must contain one value`);
  validateScalar(role, value);
}

function validateScalar(role: CompiledProcedureRole, value: unknown): void {
  const valid = role.type === "number"
    ? typeof value === "number" && Number.isFinite(value)
    : typeof value === "string" && value.length > 0;
  if (!valid) throw new TypeError(`Role "${role.name}" must be a ${role.type}`);
  if (role.type === "instant" && Number.isNaN(Date.parse(String(value)))) {
    throw new TypeError(`Role "${role.name}" must be an RFC3339 instant`);
  }
}

function requiredCheckNames(
  check: DraftPlanCheck,
  roles: readonly CompiledProcedureRole[],
): readonly string[] {
  const names = new Set<string>();
  for (const guard of check.check.qualification.guards) {
    for (const reference of guard.references) {
      if (reference.kind === "check") names.add(reference.check);
    }
  }
  for (const binding of check.check.inputBindings) {
    const role = roles.find((candidate) => candidate.name === binding.role);
    if (role?.source.kind === "operation-field") names.add(role.source.check);
  }
  return [...names];
}

function retainChecksWithAvailableProviders(
  checks: readonly DraftPlanCheck[],
  roles: readonly CompiledProcedureRole[],
  context: readonly ContextValue[],
): readonly DraftPlanCheck[] {
  let retained = [...checks];
  while (true) {
    const byName = new Map<string, DraftPlanCheck[]>();
    for (const check of retained) {
      const values = byName.get(check.check.name) ?? [];
      values.push(check);
      byName.set(check.check.name, values);
    }
    const next = retained.filter((check) => requiredCheckNames(check, roles).every((name) => (
      relatedProviders(check, byName.get(name) ?? [], context).length > 0
    )));
    if (next.length === retained.length) return Object.freeze(next);
    retained = next;
  }
}

function roleDependsOnOptionalDeclaration(
  role: CompiledProcedureRole,
  roles: readonly CompiledProcedureRole[],
  visited: ReadonlySet<string> = new Set(),
): boolean {
  if (role.source.kind === "agent-declaration" && role.source.optional === true) return true;
  if (visited.has(role.name)) return false;
  const next = new Set(visited).add(role.name);
  return role.parents.some(({ role: parentName }) => {
    const parent = roles.find((candidate) => candidate.name === parentName);
    return parent !== undefined && roleDependsOnOptionalDeclaration(parent, roles, next);
  });
}

function contextValue(scope: PlanCheck["scope"]): ContextValue {
  return { role: scope.role, value: scope.value, parents: scope.parents };
}

function uriValue(value: unknown): string {
  return typeof value === "string" ? value : canonicalJson(value);
}

function uniqueValues(values: readonly unknown[]): readonly unknown[] {
  const byValue = new Map(values.map((value) => [canonicalJson(value), value]));
  return [...byValue.values()];
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneObject(value: Readonly<Record<string, unknown>>): RuntimeJsonObject {
  return Object.freeze(cloneJson(value));
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
