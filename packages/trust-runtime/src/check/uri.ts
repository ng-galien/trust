import { createHash } from "node:crypto";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const OPERATION = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DNS_AUTHORITY = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const IPV4_AUTHORITY = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const SECRET_LIKE = /(?:^|[^a-z0-9])(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{8,}|bearer\s+[a-z0-9._-]{8,})/i;

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

export function assertNoSecretLikeValue(value: string, label: string): void {
  if (SECRET_LIKE.test(value)) {
    throw new TypeError(`${label} contains a secret-like value`);
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
    throw new TypeError("Authority must be a lowercase host with an optional port");
  }

  const separator = authority.lastIndexOf(":");
  const hasPort = separator > -1;
  const host = hasPort ? authority.slice(0, separator) : authority;
  const portText = hasPort ? authority.slice(separator + 1) : undefined;

  if (!host || (!DNS_AUTHORITY.test(host) && !isValidIpv4(host))) {
    throw new TypeError("Authority host is invalid");
  }

  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) {
      throw new TypeError("Authority port is invalid");
    }
    const port = Number(portText);
    if (port < 1 || port > 65_535 || String(port) !== portText) {
      throw new TypeError("Authority port is invalid");
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

function isValidIpv4(host: string): boolean {
  if (!IPV4_AUTHORITY.test(host)) {
    return false;
  }
  return host.split(".").every((part) => Number(part) <= 255 && String(Number(part)) === part);
}
