import type { CompiledProcedure } from "@trust/procedure";
import type { Selectable } from "kysely";

import type { Database, PublishedProcedureTable } from "../database/database.js";

type ProcedureRow = Selectable<PublishedProcedureTable>;

export interface PublishedProcedure {
  readonly procedure: CompiledProcedure;
  readonly sourceName: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export class ProcedureStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  async publish(
    procedure: CompiledProcedure,
    sourceName: string,
    publishedBy: string,
    publishedAt: string,
  ): Promise<PublishedProcedure> {
    return this.dependencies.database.transaction().execute(async (transaction) => {
      const existingRow = await transaction
        .selectFrom("published_procedures")
        .selectAll()
        .where("procedure_name", "=", procedure.procedure)
        .where("procedure_version", "=", procedure.version)
        .executeTakeFirst();
      if (existingRow) {
        const existing = toPublishedProcedure(existingRow);
        if (
          existing.procedure.definitionDigest !== procedure.definitionDigest
          || existing.procedure.source !== procedure.source
        ) {
          throw new ProcedureConflictError(
            `Procedure ${procedure.procedure}@${procedure.version} is already published with another immutable definition`,
          );
        }
        return existing;
      }

      await transaction.insertInto("published_procedures").values({
        procedure_name: procedure.procedure,
        procedure_version: procedure.version,
        definition_digest: procedure.definitionDigest,
        source_name: sourceName,
        source: procedure.source,
        compiled_procedure_json: JSON.stringify(procedure),
        published_by: publishedBy,
        published_at: publishedAt,
      }).execute();

      const published = await transaction
        .selectFrom("published_procedures")
        .selectAll()
        .where("procedure_name", "=", procedure.procedure)
        .where("procedure_version", "=", procedure.version)
        .executeTakeFirst();
      if (!published) throw new Error("Published Procedure cannot be read back");
      return toPublishedProcedure(published);
    });
  }

  async find(procedure: string, version: string): Promise<PublishedProcedure | undefined> {
    const row = await this.dependencies.database
      .selectFrom("published_procedures")
      .selectAll()
      .where("procedure_name", "=", procedure)
      .where("procedure_version", "=", version)
      .executeTakeFirst();
    return row ? toPublishedProcedure(row) : undefined;
  }

  async list(): Promise<PublishedProcedure[]> {
    const rows = await this.dependencies.database
      .selectFrom("published_procedures")
      .selectAll()
      .orderBy("procedure_name")
      .orderBy("procedure_version")
      .execute();
    return rows.map(toPublishedProcedure);
  }

  async findOperation(
    operation: string,
    digest: string,
  ): Promise<{ readonly operation: string; readonly digest: string } | undefined> {
    const rows = await this.dependencies.database
      .selectFrom("published_procedures")
      .select("compiled_procedure_json")
      .orderBy("definition_digest")
      .execute();
    const match = rows
      .map((row) => JSON.parse(row.compiled_procedure_json) as CompiledProcedure)
      .flatMap((procedure) => procedure.operations)
      .find((candidate) => candidate.operation === operation && candidate.digest === digest);
    return match ? { operation, digest } : undefined;
  }
}

function toPublishedProcedure(row: ProcedureRow): PublishedProcedure {
  const compiled = JSON.parse(row.compiled_procedure_json) as CompiledProcedure;
  if (
    compiled.contract !== "trust.compiled-procedure@3"
    || compiled.procedure !== row.procedure_name
    || compiled.version !== row.procedure_version
    || compiled.definitionDigest !== row.definition_digest
    || compiled.source !== row.source
  ) {
    throw new Error("Persisted Procedure is inconsistent");
  }
  return {
    procedure: compiled,
    sourceName: row.source_name,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
  };
}

export class ProcedureConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcedureConflictError";
  }
}
