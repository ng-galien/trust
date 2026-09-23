import type { CatalogMetadata, MissionDefinition } from "./index.js";

/** Total dispatch over the catalog resource kind. */
export function matchCatalogMetadataKind<R>(
  metadata: CatalogMetadata,
  handlers: { readonly operation: () => R; readonly procedure: () => R },
): R {
  return handlers[metadata.kind]();
}

export type MissionDefinitionHandlers<R> = {
  [K in MissionDefinition["kind"]]: (definition: Extract<MissionDefinition, { kind: K }>) => R;
};

/** Total dispatch over the canonical published/inline mission definition. */
export function matchMissionDefinition<R>(definition: MissionDefinition, handlers: MissionDefinitionHandlers<R>): R {
  // TypeScript cannot retain the discriminant/handler correlation through indexing.
  return handlers[definition.kind](definition as never);
}
