import type { CompiledProcedure } from "@trust/procedure";

import type { PlanCheck, PlanRevision } from "../model.js";

export const MAX_INTENT_LENGTH = 1_024;

export function isIntentValue(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_INTENT_LENGTH
    && value.trim() === value
    && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

/** Whether validating this current Check can complete the Plan without materializing another Check. */
export function completesPlanOnValidation(input: {
  readonly procedure: CompiledProcedure;
  readonly revision: PlanRevision;
  readonly checks: readonly PlanCheck[];
  readonly activeCheckUris: ReadonlySet<string>;
  readonly check: PlanCheck;
}): boolean {
  const { procedure, revision, checks, activeCheckUris, check } = input;
  const missingDeclarations = procedure.roles.some((role) => (
    role.source.kind === "agent-declaration" && !Object.hasOwn(revision.agentDeclarations, role.name)
  ));
  if (missingDeclarations) return false;
  const affected = dependentCheckUris(checks, check.uri);
  if (checks.some((candidate) => (
    candidate.uri !== check.uri
    && (!activeCheckUris.has(candidate.uri) || affected.has(candidate.uri))
  ))) {
    return false;
  }
  const materializedRoles = new Set(check.check.materializes.map((item) => item.role));
  return !procedure.checks.some((candidate) => (
    (candidate.scenario !== check.check.scenario || candidate.name !== check.check.name)
    && candidate.inputBindings.some((binding) => materializedRoles.has(binding.role))
  ));
}

export function dependentCheckUris(checks: readonly PlanCheck[], providerUri: string): Set<string> {
  const affected = new Set<string>();
  const queue = [providerUri];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const candidate of checks) {
      if (affected.has(candidate.uri) || candidate.uri === providerUri) continue;
      const dependsOnCheck = candidate.checkDependencies.some((dependency) => dependency.providerCheckUri === current);
      const dependsOnScenario = candidate.scenarioDependencies.some((scenario) => checks.some((upstream) => (
        upstream.scenario === scenario && upstream.uri === current
      )));
      if (dependsOnCheck || dependsOnScenario) {
        affected.add(candidate.uri);
        queue.push(candidate.uri);
      }
    }
  }
  return affected;
}
