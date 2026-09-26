import { createHash } from "node:crypto";
import { assertNoSecretLikeValue, normalizeAuthority } from "@trust/extension-sdk";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const OPERATION = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function assertCanonicalSlug(value: string, label: string): void {
  if (!SLUG.test(value) || value.length > 63) {
    throw new TypeError(`${label} must be a canonical lowercase slug`);
  }
  assertNoSecretLikeValue(value, label);
}

export function assertSemanticVersion(value: string): void {
  if (!VERSION.test(value)) {
    throw new TypeError("Procedure version must be an exact semantic version");
  }
}

export function buildSemanticCheckUri(input: {
  authority: string;
  procedure: string;
  version: string;
  plan: string;
  scenario: string;
  check: string;
  operation: string;
  expansion?: readonly string[];
}): string {
  const authority = normalizeAuthority(input.authority);
  assertCanonicalSlug(input.procedure, "procedure");
  assertSemanticVersion(input.version);
  assertCanonicalSlug(input.plan, "plan");
  assertCanonicalSlug(input.scenario, "scenario");
  const checkSegment = semanticCheckSegment(input.check);
  const operationSegment = semanticOperationSegment(input.operation);

  const path = [
    `${input.procedure}@${input.version}`,
    input.plan,
    input.scenario,
    checkSegment,
    operationSegment,
    ...(input.expansion ?? []).map(semanticExpansionSegment),
  ].join("/");

  return `trust://${authority}/${path}`;
}

/**
 * A dynamic Plan value is product data, not an URI authoring constraint.
 * Preserve already-canonical segments for stable existing Check URIs and derive
 * one opaque, full-entropy segment for every other value. The declared value
 * remains unchanged in the Plan, Check expansion and Skill action input.
 */
export function semanticExpansionSegment(value: string): string {
  if (SLUG.test(value) && value.length <= 63) {
    assertNoSecretLikeValue(value, "Check target");
    return value;
  }
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  const base36 = BigInt(`0x${digest}`).toString(36).padStart(50, "0");
  return `declared-${base36}`;
}

export function semanticOperationSegment(operation: string): string {
  assertNoSecretLikeValue(operation, "Operation");
  const match = operation.match(OPERATION);
  if (!match) {
    throw new TypeError("Operation must use the canonical <domain>.<operation> form");
  }
  const [, domain, action] = match;
  if (!domain || !action) {
    throw new TypeError("Operation is incomplete");
  }
  return `${domain}-${action}`;
}

function semanticCheckSegment(check: string): string {
  assertNoSecretLikeValue(check, "Check");
  if (SLUG.test(check) && check.length <= 63) return check;
  const digest = createHash("sha256").update(check, "utf8").digest("hex");
  return `check-${BigInt(`0x${digest}`).toString(36).padStart(50, "0")}`;
}
