import { compare, maxSatisfying, prerelease, valid, validRange } from "semver";

/** Canonical npm-style resource reference. Names remain TRUST identifiers, not npm package names. */
export function parseResourceReference(reference: string): { name: string; selector: string } | undefined {
  const separator = reference.indexOf("@");
  if (separator < 1) return undefined;
  const name = reference.slice(0, separator);
  const selector = reference.slice(separator + 1);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(name) || !selector.trim() || !validRange(selector)) return undefined;
  return { name, selector };
}

export function isExactVersion(version: string): boolean {
  return /^\d/.test(version) && version.trim() === version && valid(version) !== null;
}
export function compareVersions(left: string, right: string): number {
  return compare(left, right);
}
export function isPrerelease(version: string): boolean {
  return prerelease(version) !== null;
}
export function selectVersion(versions: readonly string[], selector: string): string | null {
  return validRange(selector) ? maxSatisfying([...versions], selector) : null;
}
