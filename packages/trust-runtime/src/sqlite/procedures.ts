import type { CompiledProcedure } from "@trust/procedure";

import type { DatabaseDriver, DatabaseRow } from "./database.js";

interface ProcedureRow extends DatabaseRow {
  procedure_name: string;
  procedure_version: string;
  definition_digest: string;
  source_name: string;
  source: string;
  compiled_procedure_json: string;
  published_by: string;
  published_at: string;
}

interface CompiledProcedureRow extends DatabaseRow {
  compiled_procedure_json: string;
}

export interface PublishedProcedure {
  readonly procedure: CompiledProcedure;
  readonly sourceName: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export class ProcedureStore {
  readonly #database: DatabaseDriver;

  constructor({ databaseDriver }: { readonly databaseDriver: DatabaseDriver }) {
    this.#database = databaseDriver;
  }

  publish(
    procedure: CompiledProcedure,
    sourceName: string,
    publishedBy: string,
    publishedAt: string,
  ): PublishedProcedure {
    return this.#database.transaction(() => {
      const existing = this.find(procedure.procedure, procedure.version);
      if (existing) {
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

      this.#database.prepare(
        `INSERT INTO published_procedures (
           procedure_name, procedure_version, definition_digest, source_name, source,
           compiled_procedure_json, published_by, published_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        procedure.procedure,
        procedure.version,
        procedure.definitionDigest,
        sourceName,
        procedure.source,
        JSON.stringify(procedure),
        publishedBy,
        publishedAt,
      );

      const published = this.find(procedure.procedure, procedure.version);
      if (!published) throw new Error("Published Procedure cannot be read back");
      return published;
    });
  }

  find(procedure: string, version: string): PublishedProcedure | undefined {
    const row = this.#database.prepare(
      `SELECT procedure_name, procedure_version, definition_digest, source_name, source,
              compiled_procedure_json, published_by, published_at
         FROM published_procedures
        WHERE procedure_name = ? AND procedure_version = ?`,
    ).get<ProcedureRow>(procedure, version);
    if (!row) return undefined;
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

  findOperation(
    operation: string,
    digest: string,
  ): { readonly operation: string; readonly digest: string } | undefined {
    const matches = this.#database.prepare(
      `SELECT compiled_procedure_json FROM published_procedures ORDER BY definition_digest`,
    ).all<CompiledProcedureRow>()
      .map((row) => JSON.parse(row.compiled_procedure_json) as CompiledProcedure)
      .flatMap((procedure) => procedure.operations)
      .filter((candidate) => candidate.operation === operation && candidate.digest === digest);
    return matches.length === 0 ? undefined : { operation, digest };
  }
}

export class ProcedureConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcedureConflictError";
  }
}
