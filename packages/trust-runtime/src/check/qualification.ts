import { validateOperationProduced } from "@trust/operation";
import {
  evaluateQualificationCondition,
  evaluateQualificationRule,
  procedureLanguage,
  type CompiledExpressionReference,
} from "@trust/procedure";

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
  readonly reasonCode: "check-qualified" | "qualification-not-satisfied";
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
  const rawData = expressionData(check, facts.values, available);
  for (const guard of check.check.qualification.guards) {
    const conditionData = normalizeInstants(rawData, guard.references);
    if (!evaluateQualificationCondition(guard.conditionLogic, conditionData)) {
      const reason = evaluateQualificationRule(guard.failureReasonLogic, rawData);
      if (typeof reason !== "string" || reason.length === 0) {
        throw new TypeError("A failed qualification guard must produce a non-empty reason");
      }
      return {
        verdict: "NOT_VALIDATED",
        reasonCode: "qualification-not-satisfied",
        reason,
      };
    }
  }
  return {
    verdict: "VALIDATED",
    reasonCode: "check-qualified",
    reason: check.check.successReason,
  };
}

function expressionData(
  check: PlanCheck,
  facts: RuntimeJsonObject,
  available: readonly CheckValues[],
): RuntimeJsonObject {
  const roots = procedureLanguage.qualification.roots;
  const referencedChecks = new Set(
    check.check.qualification.guards
      .flatMap((guard) => guard.references)
      .filter((reference): reference is Extract<CompiledExpressionReference, { readonly kind: "check" }> =>
        reference.kind === "check")
      .map((reference) => reference.check),
  );
  const checks: Record<string, RuntimeJsonObject> = {};
  for (const checkName of referencedChecks) {
    const providers = new Set(
      check.checkDependencies
        .filter((dependency) => dependency.checkName === checkName)
        .map((dependency) => dependency.providerCheckUri),
    );
    const candidates = available.filter((item) =>
      item.checkName === checkName
      && (providers.size === 0 || providers.has(item.providerCheckUri))
    );
    if (candidates.length !== 1) {
      throw new TypeError(`Check "${checkName}" does not provide one unambiguous value`);
    }
    checks[checkName] = candidates[0]!.values;
  }
  return Object.freeze({
    [roots.fact]: facts,
    [roots.context]: check.context,
    [roots.checks]: Object.freeze(checks),
  });
}

function normalizeInstants(
  data: RuntimeJsonObject,
  references: readonly CompiledExpressionReference[],
): RuntimeJsonObject {
  const roots = procedureLanguage.qualification.roots;
  const normalized = cloneJson(data) as Record<string, unknown>;
  for (const reference of references) {
    if (reference.valueType !== "instant") continue;
    const path = reference.kind === "fact"
      ? [roots.fact, reference.field]
      : reference.kind === "context"
        ? [roots.context, reference.role]
        : [roots.checks, reference.check, reference.field];
    const value = readPath(normalized, path);
    const converted = reference.cardinality === "many"
      ? requireArray(value, path).map((item) => instant(item, path))
      : instant(value, path);
    writePath(normalized, path, converted);
  }
  return Object.freeze(normalized);
}

function instant(value: unknown, path: readonly string[]): number {
  if (typeof value !== "string") throw new TypeError(`Expression value "${path.join(".")}" must be an instant`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError(`Expression value "${path.join(".")}" must be an RFC3339 instant`);
  return parsed;
}

function requireArray(value: unknown, path: readonly string[]): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`Expression value "${path.join(".")}" must be an array`);
  return value;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      throw new TypeError(`Expression value "${path.join(".")}" is unavailable`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(value: Record<string, unknown>, path: readonly string[], replacement: unknown): void {
  let current = value;
  for (const segment of path.slice(0, -1)) current = current[segment] as Record<string, unknown>;
  current[path.at(-1)!] = replacement;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
