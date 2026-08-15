import type { Fact } from "../model.js";
import type { DatabaseDriver, DatabaseRow } from "./database.js";

interface FactRow extends DatabaseRow {
  fact_id: string;
  attempt_handle: string;
  check_uri: string;
  compiled_digest: string;
  fact_index: number;
  operation: string;
  operation_digest: string;
  observed_at: string;
  recorded_at: string;
  payload_json: string;
}

export interface FactAppendResult {
  readonly acceptedIds: readonly string[];
  readonly duplicateIds: readonly string[];
}

export class FactStore {
  readonly #database: DatabaseDriver;

  constructor({ databaseDriver }: { readonly databaseDriver: DatabaseDriver }) {
    this.#database = databaseDriver;
  }

  append(facts: readonly Fact[]): FactAppendResult {
    return this.#database.transaction(() => {
      const acceptedIds: string[] = [];
      const duplicateIds: string[] = [];
      for (const fact of facts) {
        const received = this.atIndex(fact.attemptHandle, fact.index);
        if (received) {
          if (canonicalJson(received) !== canonicalJson(fact)) {
            throw new Error(`Fact index collision for ${fact.attemptHandle} at ${fact.index}`);
          }
          acceptedIds.push(fact.id);
          duplicateIds.push(fact.id);
          continue;
        }
        const existing = this.#database.prepare("SELECT fact_id FROM facts WHERE fact_id = ?")
          .get<{ fact_id: string } & DatabaseRow>(fact.id);
        if (!existing) {
          this.#database.prepare(
            `INSERT INTO facts (
               fact_id, check_uri, compiled_digest, fact_index, operation,
               operation_digest, observed_at, payload_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            fact.id,
            fact.checkUri,
            fact.compiledCheckDigest,
            fact.index,
            fact.operation,
            fact.operationDigest,
            fact.observedAt,
            JSON.stringify(fact.values),
          );
        } else {
          duplicateIds.push(fact.id);
        }
        this.#database.prepare(
          `INSERT INTO attempt_fact_receipts (attempt_handle, fact_id, fact_index, recorded_at)
           VALUES (?, ?, ?, ?)`,
        ).run(fact.attemptHandle, fact.id, fact.index, fact.recordedAt);
        acceptedIds.push(fact.id);
      }
      return { acceptedIds, duplicateIds };
    });
  }

  list(attemptHandle: string): Fact[] {
    return this.#database.prepare(
      `SELECT f.fact_id, r.attempt_handle, f.check_uri, f.compiled_digest, r.fact_index,
              f.operation, f.operation_digest, f.observed_at, r.recorded_at, f.payload_json
         FROM attempt_fact_receipts r
         JOIN facts f ON f.fact_id = r.fact_id
        WHERE r.attempt_handle = ? ORDER BY r.fact_index`,
    ).all<FactRow>(attemptHandle).map(toFact);
  }

  private atIndex(attemptHandle: string, index: number): Fact | undefined {
    const row = this.#database.prepare(
      `SELECT f.fact_id, r.attempt_handle, f.check_uri, f.compiled_digest, r.fact_index,
              f.operation, f.operation_digest, f.observed_at, r.recorded_at, f.payload_json
         FROM attempt_fact_receipts r
         JOIN facts f ON f.fact_id = r.fact_id
        WHERE r.attempt_handle = ? AND r.fact_index = ?`,
    ).get<FactRow>(attemptHandle, index);
    return row ? toFact(row) : undefined;
  }
}

function toFact(row: FactRow): Fact {
  return {
    id: row.fact_id,
    attemptHandle: row.attempt_handle,
    checkUri: row.check_uri,
    compiledCheckDigest: row.compiled_digest,
    index: row.fact_index,
    operation: row.operation,
    operationDigest: row.operation_digest,
    observedAt: row.observed_at,
    recordedAt: row.recorded_at,
    values: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
