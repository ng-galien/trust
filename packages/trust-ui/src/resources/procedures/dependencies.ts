import type { CompiledProcedure, CompiledProcedureCheck, CompiledProcedureRole } from "@trust/procedure";
import { matchExpressionReference, matchProcedureRoleSource } from "@trust/procedure/match";
import { i18next } from "../../i18n/index.js";

/* Dependency reading of a compiled procedure, mirroring the runtime rules:
   - a Check DEPENDS ON another Check when it binds a role that Check materializes (operation-field role)
     or when its qualification references a field of that Check;
   - a Check WAITS FOR every Check of the Scenarios its Scenario declares as prerequisites;
   - a new verdict on a Check RESETS, transitively, every Check that depends on it or waits for it. */

export type RoleProvenance = CompiledProcedureRole["source"] &
  Pick<CompiledProcedureRole, "type" | "cardinality"> & { readonly role: string };

/** One value flowing from a producing Check to a consuming Check. */
export interface DataLink {
  from: string;
  to: string;
  /** Materialized role bound as input (input name), or field used by a qualification. */
  role?: string;
  input?: string;
  field?: string;
}

export function roleProvenance(procedure: CompiledProcedure, roleName: string): RoleProvenance | undefined {
  const role = procedure.roles.find((candidate) => candidate.name === roleName);
  if (!role) return undefined;
  return { ...role.source, role: role.name, type: role.type, cardinality: role.cardinality };
}

export function describeProvenance(provenance: RoleProvenance | undefined): string {
  if (!provenance) return i18next.t("procedures.provenance.unknownRole");
  return matchProcedureRoleSource(provenance, {
    "plan-input": () => i18next.t("procedures.provenance.planInput"),
    fixed: (value) => i18next.t("procedures.provenance.fixed", { value: JSON.stringify(value.value) }),
    "agent-declaration": () => i18next.t("procedures.provenance.agentDeclaration"),
    "operation-field": (value) =>
      i18next.t("procedures.provenance.operationField", { check: value.check, field: value.field }),
    "invocation-result": (value) =>
      i18next.t("procedures.provenance.invocationResult", { invocation: value.invocation, result: value.result }),
    "plan-identifier": () => i18next.t("procedures.provenance.planIdentifier"),
  });
}

/** Every data link of the procedure, exactly the runtime's check dependencies. */
export function dataLinks(procedure: CompiledProcedure): DataLink[] {
  const links: DataLink[] = [];
  for (const check of procedure.checks) {
    for (const binding of check.inputBindings ?? []) {
      const provenance = roleProvenance(procedure, binding.role);
      if (provenance)
        matchProcedureRoleSource(provenance, {
          "operation-field": (source) => {
            if (source.check !== check.name)
              links.push({ from: source.check, to: check.name, role: binding.role, input: binding.input });
          },
          "invocation-result": (source) => {
            links.push({ from: source.invocation, to: check.name, role: binding.role, input: binding.input });
          },
          "plan-input": () => {},
          "agent-declaration": () => {},
          fixed: () => {},
          "plan-identifier": () => {},
        });
    }
    for (const guard of check.qualification.guards) {
      for (const reference of guard.references) {
        matchExpressionReference(reference, {
          check: (source) => {
            if (source.check !== check.name) links.push({ from: source.check, to: check.name, field: source.field });
          },
          fact: () => {},
          context: () => {},
        });
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
export function orderPrerequisites(
  procedure: CompiledProcedure,
  check: CompiledProcedureCheck,
): Array<{ scenario: string; title: string; checks: readonly string[] }> {
  const scenario = procedure.scenarios.find((candidate) => candidate.slug === check.scenario);
  return (scenario?.dependencies ?? []).map((slug) => {
    const prerequisite = procedure.scenarios.find((candidate) => candidate.slug === slug);
    return { scenario: slug, title: prerequisite?.title ?? slug, checks: prerequisite?.checks ?? [] };
  });
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
    const currentScenarios = new Set(
      procedure.checks.filter((check) => current.has(check.name)).map((check) => check.scenario),
    );
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
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const check = procedure.checks.find((candidate) => candidate.name === name);
    if (!check) continue;
    const next = new Set<string>();
    for (const link of links) if (link.to === name) next.add(link.from);
    for (const prerequisite of orderPrerequisites(procedure, check))
      for (const dependency of prerequisite.checks) next.add(dependency);
    for (const candidate of next) {
      if (seedSet.has(candidate) || needed.has(candidate)) continue;
      needed.add(candidate);
      queue.push(candidate);
    }
  }
  return needed;
}
