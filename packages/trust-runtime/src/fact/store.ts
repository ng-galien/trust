import type { Database } from "../database/database.js";
import type { Fact } from "../model.js";

interface FactRow {
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
  constructor(private readonly dependencies: { readonly database: Database }) {}

  using(database: Database): FactStore {
    return new FactStore({ database });
  }

  async append(facts: readonly Fact[]): Promise<FactAppendResult> {
    const database = this.dependencies.database;
    const acceptedIds: string[] = [];
    const duplicateIds: string[] = [];
    for (const fact of facts) {
      const received = await factAtIndex(database, fact.attemptHandle, fact.index);
      if (received) {
        if (canonicalJson(received) !== canonicalJson(fact)) {
          throw new Error(`Fact index collision for ${fact.attemptHandle} at ${fact.index}`);
        }
        acceptedIds.push(fact.id);
        duplicateIds.push(fact.id);
        continue;
      }
      const existing = await database
        .selectFrom("facts")
        .select("fact_id")
        .where("fact_id", "=", fact.id)
        .executeTakeFirst();
      if (!existing) {
        await database.insertInto("facts").values({
          fact_id: fact.id,
          check_uri: fact.checkUri,
          compiled_digest: fact.compiledCheckDigest,
          fact_index: fact.index,
          operation: fact.operation,
          operation_digest: fact.operationDigest,
          observed_at: fact.observedAt,
          payload_json: JSON.stringify(fact.values),
        }).execute();
      } else {
        duplicateIds.push(fact.id);
      }
      await database.insertInto("attempt_fact_receipts").values({
        attempt_handle: fact.attemptHandle,
        fact_id: fact.id,
        fact_index: fact.index,
        recorded_at: fact.recordedAt,
      }).execute();
      acceptedIds.push(fact.id);
    }
    return { acceptedIds, duplicateIds };
  }

  async list(attemptHandle: string): Promise<Fact[]> {
    const rows = await factRows(this.dependencies.database, attemptHandle);
    return rows.map(toFact);
  }
}

async function factAtIndex(
  transaction: Database,
  attemptHandle: string,
  index: number,
): Promise<Fact | undefined> {
  const row = await transaction
    .selectFrom("attempt_fact_receipts as receipt")
    .innerJoin("facts as fact", "fact.fact_id", "receipt.fact_id")
    .select([
      "fact.fact_id",
      "receipt.attempt_handle",
      "fact.check_uri",
      "fact.compiled_digest",
      "receipt.fact_index",
      "fact.operation",
      "fact.operation_digest",
      "fact.observed_at",
      "receipt.recorded_at",
      "fact.payload_json",
    ])
    .where("receipt.attempt_handle", "=", attemptHandle)
    .where("receipt.fact_index", "=", index)
    .executeTakeFirst();
  return row ? toFact(row) : undefined;
}

async function factRows(database: Database, attemptHandle: string): Promise<FactRow[]> {
  return database
    .selectFrom("attempt_fact_receipts as receipt")
    .innerJoin("facts as fact", "fact.fact_id", "receipt.fact_id")
    .select([
      "fact.fact_id",
      "receipt.attempt_handle",
      "fact.check_uri",
      "fact.compiled_digest",
      "receipt.fact_index",
      "fact.operation",
      "fact.operation_digest",
      "fact.observed_at",
      "receipt.recorded_at",
      "fact.payload_json",
    ])
    .where("receipt.attempt_handle", "=", attemptHandle)
    .orderBy("receipt.fact_index")
    .execute();
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
