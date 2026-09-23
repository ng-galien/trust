import type { CatalogMetadata } from "@trust/extension-sdk";
import { compareVersions } from "@trust/operation/version";
import type { OperationCatalog } from "../operation/catalog.js";
import type { Procedures } from "../procedure/procedures.js";
import type { CatalogMetadataStore } from "./metadata-store.js";

export class InvalidCatalogMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCatalogMetadataError";
  }
}

export class CatalogMetadataService {
  constructor(
    private readonly dependencies: {
      readonly metadataStore: CatalogMetadataStore;
      readonly operationCatalog: OperationCatalog;
      readonly procedures: Procedures;
    },
  ) {}

  async list(): Promise<CatalogMetadata[]> {
    const { operationCatalog, procedures, metadataStore } = this.dependencies;
    const entries = new Map<string, { readonly metadata: CatalogMetadata; readonly version: string }>();
    for (const operation of operationCatalog.list()) {
      const key = `operation:${operation.operation}`;
      const previous = entries.get(key);
      if (previous && compareVersions(previous.version, operation.version) >= 0) continue;
      entries.set(key, {
        version: operation.version,
        metadata: {
          kind: "operation",
          name: operation.operation,
          revision: 0,
          title: operation.title,
          ...(operation.description === undefined ? {} : { description: operation.description }),
          tags: classificationTags(operation.classification),
        },
      });
    }
    for (const { procedure } of await procedures.list()) {
      const key = `procedure:${procedure.procedure}`;
      const previous = entries.get(key);
      if (previous && compareVersions(previous.version, procedure.version) >= 0) continue;
      entries.set(key, {
        version: procedure.version,
        metadata: {
          kind: "procedure",
          name: procedure.procedure,
          revision: 0,
          title: procedure.title,
          ...(procedure.description === undefined ? {} : { description: procedure.description }),
          tags: [],
        },
      });
    }
    for (const metadata of await metadataStore.list()) {
      const key = `${metadata.kind}:${metadata.name}`;
      const previous = entries.get(key);
      if (previous) entries.set(key, { metadata, version: previous.version });
    }
    return [...entries.values()].map((entry) => entry.metadata);
  }

  async history(kind: CatalogMetadata["kind"], name: string): Promise<CatalogMetadata[]> {
    const current = (await this.list()).find((item) => item.kind === kind && item.name === name);
    if (!current) throw new InvalidCatalogMetadataError(`${kind} ${name} is not published`);
    return this.dependencies.metadataStore.history(kind, name);
  }

  async save(input: unknown): Promise<CatalogMetadata> {
    const parsed = parseInput(input);
    const current = (await this.list()).find((item) => item.kind === parsed.kind && item.name === parsed.name);
    if (!current) throw new InvalidCatalogMetadataError(`${parsed.kind} ${parsed.name} is not published`);
    return this.dependencies.metadataStore.save(parsed);
  }
}

function classificationTags(classification: Readonly<Record<string, readonly string[]>> | undefined): string[] {
  return Object.entries(classification ?? {}).flatMap(([key, values]) => values.map((value) => `${key}:${value}`));
}

function parseInput(
  input: unknown,
): Omit<CatalogMetadata, "revision" | "updatedAt"> & { readonly expectedRevision: number } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidCatalogMetadataError("Catalog metadata must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["kind", "name", "expectedRevision", "title", "description", "tags"].includes(key),
    ) ||
    (value.kind !== "operation" && value.kind !== "procedure") ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    typeof value.title !== "string" ||
    !boundedText(value.title, 180) ||
    (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 8_000)) ||
    !Array.isArray(value.tags) ||
    value.tags.length > 64 ||
    value.tags.some((tag) => typeof tag !== "string" || !boundedText(tag, 100)) ||
    new Set(value.tags.map((tag: string) => tag.toLowerCase())).size !== value.tags.length
  ) {
    throw new InvalidCatalogMetadataError("Catalog metadata fields are invalid");
  }
  return {
    kind: value.kind,
    name: value.name,
    expectedRevision: value.expectedRevision as number,
    title: value.title,
    ...(value.description === undefined ? {} : { description: value.description as string }),
    tags: value.tags as string[],
  };
}

function boundedText(value: string, maximum: number): boolean {
  return (
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximum &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
