import type { MissionDeclaration, MissionDeclarations, MissionDefinition } from "@trust/extension-sdk";

/** Validate untrusted mission declarations before canonical compilation or persistence. */
export function parseMissionDeclarations(value: unknown): MissionDeclarations | undefined {
  if (!record(value)) return undefined;
  const collections: Record<string, readonly MissionDeclaration[]> = Object.create(null);
  for (const [name, entries] of Object.entries(value)) {
    if (!text(name, 256) || !Array.isArray(entries)) return undefined;
    const missions: MissionDeclaration[] = [];
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!record(entry) || !exact(entry, ["id", "definition", "rootInputs"])) return undefined;
      if (!text(entry.id, 256) || ids.has(entry.id) || !record(entry.rootInputs)) return undefined;
      const definition = parseDefinition(entry.definition);
      if (!definition) return undefined;
      ids.add(entry.id);
      missions.push({ id: entry.id, definition, rootInputs: entry.rootInputs });
    }
    collections[name] = missions;
  }
  return collections;
}

function parseDefinition(value: unknown): MissionDefinition | undefined {
  if (!record(value)) return undefined;
  // This is a JSON boundary, not dispatch over an already validated canonical union.
  if (value.kind === "published" && exact(value, ["kind", "reference"]) && text(value.reference, 2_048)) {
    return { kind: "published", reference: value.reference };
  }
  if (
    value.kind === "inline" &&
    exact(value, ["kind", "procedureSource", "operationSources"]) &&
    text(value.procedureSource, 1_048_576) &&
    Array.isArray(value.operationSources) &&
    value.operationSources.every((source): source is string => text(source, 1_048_576))
  ) {
    return { kind: "inline", procedureSource: value.procedureSource, operationSources: value.operationSources };
  }
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}
