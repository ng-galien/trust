import type { CatalogMetadata } from "@trust/extension-sdk";

/** Human-readable tags for catalog search results and resource cards. */
export function catalogTags(classification: CatalogMetadata["classification"]): string[] {
  return Object.entries(classification).flatMap(([key, values]) => values.map((value) => `@x-${key}:${value}`));
}
