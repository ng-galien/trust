import { validateOperationProduced } from "@trust/operation";
import type { CompiledProcedureExpectation } from "@trust/procedure";

import type {
  CheckValues,
  Fact,
  PlanCheck,
  RuntimeJsonObject,
} from "../model.js";

export interface ValidatedFacts {
  readonly values: RuntimeJsonObject;
}

export interface CheckQualification {
  readonly verdict: "VALIDATED" | "NOT_VALIDATED";
  readonly reasonCode: "check-qualified" | "predicate-not-satisfied";
  readonly reason: string;
}

export function validateFacts(check: PlanCheck, facts: readonly Fact[]): ValidatedFacts {
  if (facts.length === 0) throw new TypeError("A Check requires at least one Fact");
  const values: Record<string, unknown> = {};
  for (const fact of facts) {
    if (
      fact.checkUri !== check.uri
      || fact.compiledCheckDigest !== check.compiledCheckDigest
      || fact.operation !== check.check.operation
      || fact.operationDigest !== check.check.operationDigest
    ) {
      throw new TypeError("Fact does not belong to the admitted Check and Operation");
    }
    for (const [name, value] of Object.entries(fact.values)) {
      if (Object.hasOwn(values, name) && canonicalJson(values[name]) !== canonicalJson(value)) {
        throw new TypeError(`Facts contain conflicting values for field "${name}"`);
      }
      values[name] = value;
    }
  }
  validateOperationProduced(check.operation, values);
  return { values: Object.freeze(values) };
}

export function qualifyCheck(
  check: PlanCheck,
  facts: ValidatedFacts,
  available: readonly CheckValues[],
): CheckQualification {
  for (const predicate of check.check.predicates) {
    const actual = facts.values[predicate.field];
    const expected = expectationValue(predicate.expectation, check, available);
    if (!matches(predicate.relation, actual, expected)) {
      return {
        verdict: "NOT_VALIDATED",
        reasonCode: "predicate-not-satisfied",
        reason: predicate.failureReason,
      };
    }
  }
  return {
    verdict: "VALIDATED",
    reasonCode: "check-qualified",
    reason: check.check.successReason,
  };
}

function expectationValue(
  expectation: CompiledProcedureExpectation,
  check: PlanCheck,
  available: readonly CheckValues[],
): unknown {
  switch (expectation.kind) {
    case "value": return expectation.value;
    case "number": return expectation.value;
    case "valid-rfc3339": return VALID_RFC3339;
    case "context": return check.context[expectation.role];
    case "check-field": {
      const providers = new Set(
        check.checkDependencies
          .filter((dependency) => dependency.checkName === expectation.check)
          .map((dependency) => dependency.providerCheckUri),
      );
      const candidates = available.filter((item) =>
        item.checkName === expectation.check
        && (providers.size === 0 || providers.has(item.providerCheckUri))
      );
      if (candidates.length !== 1) {
        throw new TypeError(`Check "${expectation.check}" does not provide one unambiguous value`);
      }
      return candidates[0]?.values[expectation.field];
    }
  }
}

const VALID_RFC3339 = Symbol("valid-rfc3339");

function matches(
  relation: PlanCheck["check"]["predicates"][number]["relation"],
  actual: unknown,
  expected: unknown,
): boolean {
  if (expected === VALID_RFC3339) {
    return typeof actual === "string" && !Number.isNaN(Date.parse(actual));
  }
  switch (relation) {
    case "equals": return canonicalJson(actual) === canonicalJson(expected);
    case "at least": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "has at least": return Array.isArray(actual) && typeof expected === "number" && actual.length >= expected;
    case "is in": return Array.isArray(expected) && expected.some((item) => canonicalJson(item) === canonicalJson(actual));
    case "before": return instant(actual) < instant(expected);
    case "after": return instant(actual) > instant(expected);
  }
}

function instant(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
