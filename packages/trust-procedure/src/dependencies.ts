export interface ScenarioDependencies {
  readonly slug: string;
  readonly dependencies: readonly string[];
}

/** Single transitive dependency calculation used by compilation, qualification visibility and authoring. */
export function transitiveScenarioDependencies(
  current: string,
  scenarios: readonly ScenarioDependencies[],
): ReadonlySet<string> {
  const bySlug = new Map(scenarios.map((scenario) => [scenario.slug, scenario]));
  const pending = [...(bySlug.get(current)?.dependencies ?? [])];
  const dependencies = new Set<string>();
  while (pending.length > 0) {
    const slug = pending.pop();
    if (!slug || dependencies.has(slug)) continue;
    dependencies.add(slug);
    pending.push(...(bySlug.get(slug)?.dependencies ?? []));
  }
  return dependencies;
}
