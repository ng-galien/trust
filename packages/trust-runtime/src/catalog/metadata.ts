import type { CatalogMetadata, CatalogMetadataUpdate } from "@trust/extension-sdk";
import type { CompiledOperation } from "@trust/operation";
import type { CompiledProcedure } from "@trust/procedure";

import type { Database } from "../database/database.js";
import type { OperationCatalog } from "../operation/catalog.js";
import type { ProcedureStore } from "../procedure/store.js";

export type CatalogKind = CatalogMetadata["kind"];
export type CatalogClassification = CatalogMetadata["classification"];

export class CatalogMetadataError extends Error {
  constructor(
    readonly reason: "unknown-entry" | "revision-conflict" | "invalid-metadata",
    message: string,
  ) {
    super(message);
    this.name = "CatalogMetadataError";
  }
}

/** Editorial catalog state. It never changes a compiled Operation or Procedure. */
export class CatalogMetadataStore {
  constructor(
    private readonly dependencies: {
      readonly database: Database;
      readonly operationCatalog: OperationCatalog;
      readonly procedureStore: ProcedureStore;
    },
  ) {}

  async read(kind: CatalogKind, name: string, version: string): Promise<CatalogMetadata | undefined> {
    const base = await this.#base(kind, name, version);
    if (!base) return undefined;
    const row = await this.dependencies.database
      .selectFrom("catalog_metadata_revisions")
      .selectAll()
      .where("kind", "=", kind)
      .where("name", "=", name)
      .where("version", "=", version)
      .orderBy("revision", "desc")
      .executeTakeFirst();
    if (!row) return base;
    return {
      kind,
      name,
      version,
      revision: row.revision,
      title: row.title,
      ...(row.description === null ? {} : { description: row.description }),
      classification: row.classification_json as CatalogClassification,
      updatedAt: row.updated_at,
    };
  }

  async history(kind: CatalogKind, name: string, version: string): Promise<readonly CatalogMetadata[] | undefined> {
    const base = await this.#base(kind, name, version);
    if (!base) return undefined;
    const rows = await this.dependencies.database
      .selectFrom("catalog_metadata_revisions")
      .selectAll()
      .where("kind", "=", kind)
      .where("name", "=", name)
      .where("version", "=", version)
      .orderBy("revision")
      .execute();
    return [
      base,
      ...rows.map((row) => ({
        kind,
        name,
        version,
        revision: row.revision,
        title: row.title,
        ...(row.description === null ? {} : { description: row.description }),
        classification: row.classification_json as CatalogClassification,
        updatedAt: row.updated_at,
      })),
    ];
  }

  async update(input: CatalogMetadataUpdate): Promise<CatalogMetadata> {
    validate(input);
    const base = await this.#base(input.kind, input.name, input.version);
    if (!base) {
      throw new CatalogMetadataError("unknown-entry", `${input.kind} ${input.name}@${input.version} is not published`);
    }
    try {
      return await this.dependencies.database.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom("catalog_metadata_revisions")
          .select("revision")
          .where("kind", "=", input.kind)
          .where("name", "=", input.name)
          .where("version", "=", input.version)
          .orderBy("revision", "desc")
          .executeTakeFirst();
        const actualRevision = row?.revision ?? 0;
        if (actualRevision !== input.expectedRevision) {
          throw new CatalogMetadataError(
            "revision-conflict",
            `Catalog metadata revision is ${actualRevision}; expected ${input.expectedRevision}`,
          );
        }
        const updatedAt = new Date().toISOString();
        const classification = normalizeClassification(input.classification);
        await transaction
          .insertInto("catalog_metadata_revisions")
          .values({
            kind: input.kind,
            name: input.name,
            version: input.version,
            revision: actualRevision + 1,
            title: input.title.trim(),
            description: input.description?.trim() || null,
            classification_json: JSON.stringify(classification),
            updated_at: updatedAt,
          })
          .execute();
        return {
          kind: input.kind,
          name: input.name,
          version: input.version,
          revision: actualRevision + 1,
          title: input.title.trim(),
          ...(input.description?.trim() ? { description: input.description.trim() } : {}),
          classification,
          updatedAt,
        };
      });
    } catch (error) {
      if (error instanceof CatalogMetadataError) throw error;
      // The primary key also protects against simultaneous writers from separate runtime processes.
      const current = await this.read(input.kind, input.name, input.version);
      if (current && current.revision !== input.expectedRevision) {
        throw new CatalogMetadataError(
          "revision-conflict",
          `Catalog metadata revision is ${current.revision}; expected ${input.expectedRevision}`,
        );
      }
      throw error;
    }
  }

  async #base(kind: CatalogKind, name: string, version: string): Promise<CatalogMetadata | undefined> {
    if (kind === "operation") {
      const operation = this.dependencies.operationCatalog.find(name, version);
      return operation ? fromOperation(operation) : undefined;
    }
    const published = await this.dependencies.procedureStore.find(name, version);
    return published ? fromProcedure(published.procedure) : undefined;
  }
}

export function matchesCatalogQuery(metadata: CatalogMetadata, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const text = [
    metadata.name,
    metadata.title,
    metadata.description ?? "",
    ...Object.entries(metadata.classification).flatMap(([key, values]) => [key, ...values]),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return normalized.split(/\s+/).every((term) => text.includes(term));
}

function fromOperation(operation: CompiledOperation): CatalogMetadata {
  return {
    kind: "operation",
    name: operation.operation,
    version: operation.version,
    revision: 0,
    title: operation.title,
    ...(operation.description ? { description: operation.description } : {}),
    classification: operation.classification ?? {},
  };
}

function fromProcedure(procedure: CompiledProcedure): CatalogMetadata {
  return {
    kind: "procedure",
    name: procedure.procedure,
    version: procedure.version,
    revision: 0,
    title: procedure.title,
    ...(procedure.description ? { description: procedure.description } : {}),
    classification: {},
  };
}

function validate(input: CatalogMetadataUpdate): void {
  if (!input.title.trim() || input.title.length > 200 || (input.description?.length ?? 0) > 10_000) {
    throw new CatalogMetadataError("invalid-metadata", "Title must be 1–200 characters; description at most 10,000");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new CatalogMetadataError("invalid-metadata", "expectedRevision must be a nonnegative integer");
  }
  for (const [key, values] of Object.entries(input.classification)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key) || !Array.isArray(values)) {
      throw new CatalogMetadataError("invalid-metadata", `Invalid classification key: ${key}`);
    }
    if (values.some((value) => typeof value !== "string" || !value || /[\s:]/.test(value))) {
      throw new CatalogMetadataError("invalid-metadata", `Invalid classification value for ${key}`);
    }
  }
}

function normalizeClassification(classification: CatalogClassification): CatalogClassification {
  return Object.fromEntries(
    Object.entries(classification)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...new Set(values)].sort()]),
  );
}
