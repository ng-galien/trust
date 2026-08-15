import { createHash } from "node:crypto";

import { ProcedureCompilationError } from "@trust/procedure";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SKILL_ACTION = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DNS_AUTHORITY = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const IPV4_AUTHORITY = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const SECRET_LIKE = /(?:^|[^a-z0-9])(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{8,}|bearer\s+[a-z0-9._-]{8,})/i;

export function assertCanonicalSlug(value: string, label: string): void {
  if (!SLUG.test(value) || value.length > 63) {
    throw new ProcedureCompilationError(
      "invalid-identifier",
      `${label} must be a canonical lowercase slug`,
    );
  }
  assertNoSecretLikeValue(value, label);
}

export function assertSemanticVersion(value: string): void {
  if (!VERSION.test(value)) {
    throw new ProcedureCompilationError(
      "invalid-identifier",
      "procedure version must be an exact semantic version",
    );
  }
}

export function assertNoSecretLikeValue(value: string, label: string): void {
  if (SECRET_LIKE.test(value)) {
    throw new ProcedureCompilationError(
      "secret-like-value",
      `${label} contains a secret-like value`,
    );
  }
}

export function normalizeAuthority(authority: string): string {
  assertNoSecretLikeValue(authority, "authority");

  if (
    authority !== authority.toLowerCase() ||
    authority.includes("@") ||
    authority.includes("/") ||
    authority.includes("?") ||
    authority.includes("#")
  ) {
    throw new ProcedureCompilationError(
      "invalid-authority",
      "authority must be a lowercase host with an optional port",
    );
  }

  const separator = authority.lastIndexOf(":");
  const hasPort = separator > -1;
  const host = hasPort ? authority.slice(0, separator) : authority;
  const portText = hasPort ? authority.slice(separator + 1) : undefined;

  if (!host || (!DNS_AUTHORITY.test(host) && !isValidIpv4(host))) {
    throw new ProcedureCompilationError("invalid-authority", "authority host is invalid");
  }

  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) {
      throw new ProcedureCompilationError("invalid-authority", "authority port is invalid");
    }
    const port = Number(portText);
    if (port < 1 || port > 65_535 || String(port) !== portText) {
      throw new ProcedureCompilationError("invalid-authority", "authority port is invalid");
    }
  }

  return authority;
}

export function buildSemanticCheckUri(input: {
  authority: string;
  procedure: string;
  version: string;
  plan: string;
  scenario: string;
  capability: string;
  expansion?: readonly string[];
}): string {
  const authority = normalizeAuthority(input.authority);
  assertCanonicalSlug(input.procedure, "procedure");
  assertSemanticVersion(input.version);
  assertCanonicalSlug(input.plan, "plan");
  assertCanonicalSlug(input.scenario, "scenario");
  const capabilitySegment = semanticCapabilitySegment(input.capability);

  const path = [
    `${input.procedure}@${input.version}`,
    input.plan,
    input.scenario,
    capabilitySegment,
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

export function semanticCapabilitySegment(capability: string): string {
  assertNoSecretLikeValue(capability, "Capability");
  const match = capability.match(SKILL_ACTION);
  if (!match) {
    throw new ProcedureCompilationError(
      "invalid-skill-action",
      "Skill action must use the canonical <skill>.<action> form",
    );
  }
  const [, skill, action] = match;
  if (!skill || !action) {
    throw new ProcedureCompilationError("invalid-skill-action", "Skill action is incomplete");
  }
  return `${skill}-${action}`;
}

function isValidIpv4(host: string): boolean {
  if (!IPV4_AUTHORITY.test(host)) {
    return false;
  }
  return host.split(".").every((part) => Number(part) <= 255 && String(Number(part)) === part);
}
