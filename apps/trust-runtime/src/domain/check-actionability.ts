import type { MaterializedCheck } from "./runtime-model.js";

/** One dependency gate shared by delegation admission and agent projections. */
export function checkDependenciesSatisfied(
  check: MaterializedCheck,
  planChecks: readonly MaterializedCheck[],
  isSatisfied: (checkUri: string) => boolean,
): boolean {
  if (check.currentContextDigest === undefined) return false;
  for (const scenario of check.scenarioDependencies) {
    const dependencies = planChecks.filter((candidate) => candidate.scenario === scenario);
    if (
      dependencies.length === 0
      || dependencies.some((candidate) => !isSatisfied(candidate.uri))
    ) {
      return false;
    }
  }
  for (const dependency of check.checkDependencies) {
    if (
      dependency.observationDigest === undefined
      || !planChecks.some((candidate) => candidate.uri === dependency.providerCheckUri)
      || !isSatisfied(dependency.providerCheckUri)
    ) {
      return false;
    }
  }
  return true;
}

/** A Check can be delegated only while open and after every compiled dependency is satisfied. */
export function checkIsActionable(
  check: MaterializedCheck,
  planChecks: readonly MaterializedCheck[],
  isSatisfied: (checkUri: string) => boolean,
): boolean {
  return !isSatisfied(check.uri)
    && checkDependenciesSatisfied(check, planChecks, isSatisfied);
}
