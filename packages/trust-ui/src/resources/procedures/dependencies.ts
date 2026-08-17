import { i18next } from "../../i18n/index.js";
import type { CompiledProcedure, JsonObject, ProcedureCheck } from "../../types.js";

/* Dependency reading of a compiled procedure, mirroring the runtime rules:
   - a Check DEPENDS ON another Check when it binds a role that Check materializes (operation-field role)
     or when a predicate expects a field of that Check (check-field expectation);
   - a Check WAITS FOR every Check of the Scenarios its Scenario declares as prerequisites;
   - a new verdict on a Check RESETS, transitively, every Check that depends on it or waits for it. */

type RoleSourceKind = "plan-input" | "fixed" | "agent-declaration" | "operation-field";

export interface RoleProvenance {
  role: string;
  type: string;
  cardinality: string;
  kind: RoleSourceKind | string;
  /** Producing Check and field for operation-field roles. */
  check?: string;
  field?: string;
  /** Fixed value for fixed roles. */
  value?: unknown;
}

/** One value flowing from a producing Check to a consuming Check. */
export interface DataLink {
  from: string;
  to: string;
  /** Materialized role bound as input (input name), or expected field (check-field predicate). */
  role?: string;
  input?: string;
  field?: string;
}

export function roleProvenance(procedure: CompiledProcedure, roleName: string): RoleProvenance | undefined {
  const role = procedure.roles.find((candidate) => candidate.name === roleName);
  if (!role) return undefined;
  const source = role.source as JsonObject;
  const kind = String(source.kind ?? "");
  const provenance: RoleProvenance = { role: role.name, type: role.type, cardinality: role.cardinality, kind };
  if (kind === "operation-field") {
    provenance.check = String(source.check ?? "");
    provenance.field = String(source.field ?? "");
  }
  if (kind === "fixed") provenance.value = source.value;
  return provenance;
}

export function describeProvenance(provenance: RoleProvenance | undefined): string {
  if (!provenance) return i18next.t("procedures.provenance.unknownRole");
  switch (provenance.kind) {
    case "plan-input": return i18next.t("procedures.provenance.planInput");
    case "fixed": return i18next.t("procedures.provenance.fixed", { value: JSON.stringify(provenance.value) });
    case "agent-declaration": return i18next.t("procedures.provenance.agentDeclaration");
    case "operation-field": return i18next.t("procedures.provenance.operationField", { check: provenance.check ?? "", field: provenance.field ?? "" });
    default: return provenance.kind;
  }
}

/** Every data link of the procedure, exactly the runtime's check dependencies. */
export function dataLinks(procedure: CompiledProcedure): DataLink[] {
  const links: DataLink[] = [];
  for (const check of procedure.checks) {
    for (const binding of check.inputBindings ?? []) {
      const provenance = roleProvenance(procedure, binding.role);
      if (provenance?.kind === "operation-field" && provenance.check && provenance.check !== check.name) {
        links.push({ from: provenance.check, to: check.name, role: binding.role, input: binding.input });
      }
    }
    for (const predicate of check.predicates) {
      const expectation = predicate.expectation as JsonObject;
      if (expectation.kind === "check-field" && typeof expectation.check === "string" && expectation.check !== check.name) {
        links.push({ from: expectation.check, to: check.name, field: String(expectation.field ?? predicate.field) });
      }
    }
  }
  return links;
}

/** Data links a Check consumes (its providers). */
export function providersOf(procedure: CompiledProcedure, checkName: string): DataLink[] {
  return dataLinks(procedure).filter((link) => link.to === checkName);
}

/** Data links a Check feeds (its consumers). */
export function consumersOf(procedure: CompiledProcedure, checkName: string): DataLink[] {
  return dataLinks(procedure).filter((link) => link.from === checkName);
}

/** Prerequisite Scenarios of a Check's Scenario, with their Checks: the Check waits for all of them. */
export function orderPrerequisites(procedure: CompiledProcedure, check: ProcedureCheck): Array<{ scenario: string; title: string; checks: string[] }> {
  const scenario = procedure.scenarios.find((candidate) => candidate.slug === check.scenario);
  return (scenario?.dependencies ?? []).map((slug) => {
    const prerequisite = procedure.scenarios.find((candidate) => candidate.slug === slug);
    return { scenario: slug, title: prerequisite?.title ?? slug, checks: prerequisite?.checks ?? [] };
  });
}

/** Scenarios that declare the given Scenario as prerequisite (direct). */
function dependentScenarios(procedure: CompiledProcedure, slug: string): string[] {
  return procedure.scenarios.filter((scenario) => scenario.dependencies.includes(slug)).map((scenario) => scenario.slug);
}

/** Checks reset by a new verdict on any of the given Checks — the runtime's transitive `dependentChecks`. */
export function downstreamOf(procedure: CompiledProcedure, seeds: readonly string[]): Set<string> {
  const links = dataLinks(procedure);
  const seedSet = new Set(seeds);
  const affected = new Set<string>();
  const involved = () => new Set([...seedSet, ...affected]);
  let changed = true;
  while (changed) {
    changed = false;
    const current = involved();
    const currentScenarios = new Set(procedure.checks.filter((check) => current.has(check.name)).map((check) => check.scenario));
    for (const check of procedure.checks) {
      if (current.has(check.name)) continue;
      const byData = links.some((link) => link.to === check.name && current.has(link.from));
      const scenario = procedure.scenarios.find((candidate) => candidate.slug === check.scenario);
      const byOrder = (scenario?.dependencies ?? []).some((dependency) => currentScenarios.has(dependency));
      if (byData || byOrder) {
        affected.add(check.name);
        changed = true;
      }
    }
  }
  return affected;
}

/** Checks the given Checks need, transitively: data providers and Checks of prerequisite Scenarios. */
export function upstreamOf(procedure: CompiledProcedure, seeds: readonly string[]): Set<string> {
  const links = dataLinks(procedure);
  const seedSet = new Set(seeds);
  const needed = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift()!;
    const check = procedure.checks.find((candidate) => candidate.name === name);
    if (!check) continue;
    const next = new Set<string>();
    for (const link of links) if (link.to === name) next.add(link.from);
    for (const prerequisite of orderPrerequisites(procedure, check)) for (const dependency of prerequisite.checks) next.add(dependency);
    for (const candidate of next) {
      if (seedSet.has(candidate) || needed.has(candidate)) continue;
      needed.add(candidate);
      queue.push(candidate);
    }
  }
  return needed;
}

