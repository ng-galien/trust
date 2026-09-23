import type { CatalogMetadata } from "@trust/extension-sdk";
import type { Selectable } from "kysely";
import type { CatalogMetadataRevisionTable, Database } from "../database/database.js";
import type { Clock } from "../time.js";

type MetadataRow = Selectable<CatalogMetadataRevisionTable>;

export class CatalogMetadataConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogMetadataConflictError";
  }
}

export class CatalogMetadataStore {
  constructor(private readonly dependencies: { readonly database: Database; readonly clock: Clock }) {}

  async list(): Promise<CatalogMetadata[]> {
    const rows = await this.dependencies.database
      .selectFrom("catalog_metadata_revisions")
      .selectAll()
      .orderBy("kind")
      .orderBy("name")
      .orderBy("revision", "desc")
      .execute();
    const latest = new Map<string, CatalogMetadata>();
    for (const row of rows) {
      const key = `${row.kind}:${row.name}`;
      if (!latest.has(key)) latest.set(key, fromRow(row));
    }
    return [...latest.values()];
  }

  async history(kind: CatalogMetadata["kind"], name: string): Promise<CatalogMetadata[]> {
    const rows = await this.dependencies.database
      .selectFrom("catalog_metadata_revisions")
      .selectAll()
      .where("kind", "=", kind)
      .where("name", "=", name)
      .orderBy("revision", "desc")
      .execute();
    return rows.map(fromRow);
  }

  async save(
    input: Omit<CatalogMetadata, "revision" | "updatedAt"> & { readonly expectedRevision: number },
  ): Promise<CatalogMetadata> {
    const { database, clock } = this.dependencies;
    return database.transaction().execute(async (transaction) => {
      const latest = await transaction
        .selectFrom("catalog_metadata_revisions")
        .selectAll()
        .where("kind", "=", input.kind)
        .where("name", "=", input.name)
        .orderBy("revision", "desc")
        .executeTakeFirst();
      const revision = latest?.revision ?? 0;
      if (revision !== input.expectedRevision) {
        throw new CatalogMetadataConflictError(
          `Catalog metadata ${input.kind}:${input.name} is at revision ${revision}; expected ${input.expectedRevision}`,
        );
      }
      const next: MetadataRow = {
        kind: input.kind,
        name: input.name,
        revision: revision + 1,
        title: input.title,
        description: input.description ?? null,
        tags_json: JSON.stringify(input.tags),
        updated_at: clock.now().toISOString(),
      };
      try {
        await transaction.insertInto("catalog_metadata_revisions").values(next).execute();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("UNIQUE constraint failed")) {
          throw new CatalogMetadataConflictError(
            `Catalog metadata ${input.kind}:${input.name} was updated concurrently`,
          );
        }
        throw error;
      }
      return fromRow(next);
    });
  }
}

function fromRow(row: MetadataRow): CatalogMetadata {
  const tags = JSON.parse(row.tags_json) as string[];
  return {
    kind: row.kind,
    name: row.name,
    revision: row.revision,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    tags,
    updatedAt: row.updated_at,
  };
}
