import { compareVersions, isPrerelease } from "@trust/operation/version";

/** One representative per identity. Prefer a stable release; retain every exact version in detail. */
export function catalogIdentities<T>(
  values: readonly T[],
  identity: (value: T) => string,
  version: (value: T) => string,
): T[] {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(identity(value), [...(groups.get(identity(value)) ?? []), value]);
  return [...groups.values()].map((entries) => {
    const ordered = [...entries].sort((a, b) => compareVersions(version(b), version(a)));
    return ordered.find((value) => !isPrerelease(version(value))) ?? ordered[0]!;
  });
}

export function orderedVersions<T>(values: readonly T[], version: (value: T) => string): T[] {
  return [...values].sort((a, b) => compareVersions(version(b), version(a)));
}
