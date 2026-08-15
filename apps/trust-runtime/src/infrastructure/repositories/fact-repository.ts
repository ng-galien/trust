import type { Fact } from "../../domain/runtime-model.js";
import type { DatabaseDriver, DatabaseRow } from "../../ports/database.js";

interface StoredFactRow extends DatabaseRow {
  fact_id: string;
  check_uri: string;
  compiled_digest: string;
  fact_index: number;
  capability: string;
  action_contract_digest: string;
  observed_at: string;
  payload_json: string;
}

interface ReceivedFactRow extends StoredFactRow {
  execution_handle: string;
  recorded_at: string;
}

interface StoredFact {
  readonly id: string;
  readonly checkUri: string;
  readonly compiledCheckDigest: string;
  readonly index: number;
  readonly capability: string;
  readonly actionContractDigest: string;
  readonly observedAt: string;
  readonly payload: Fact["payload"];
}

export interface FactAppendResult {
  readonly acceptedIds: readonly string[];
  readonly duplicateIds: readonly string[];
}

export class FactRepository {
  constructor(private readonly dependencies: { databaseDriver: DatabaseDriver }) {}

  append(facts: readonly Fact[]): FactAppendResult {
    return this.dependencies.databaseDriver.transaction(() => {
      const acceptedIds: string[] = [];
      const duplicateIds: string[] = [];
      for (const fact of facts) {
        const stored = this.findStored(fact.id);
        if (stored && !sameSemanticFact(stored, fact)) {
          throw new Error(`Fact id collision: ${fact.id}`);
        }

        const receivedAtIndex = this.findAtIndex(fact.executionHandle, fact.index);
        if (receivedAtIndex) {
          if (!sameReceivedFact(receivedAtIndex, fact)) {
            throw new Error(
              `Fact index collision for ${fact.executionHandle} at ${fact.index}`,
            );
          }
          duplicateIds.push(fact.id);
          acceptedIds.push(fact.id);
          continue;
        }

        if (stored) {
          duplicateIds.push(fact.id);
        } else {
          this.dependencies.databaseDriver
            .prepare(
              `INSERT INTO facts (
                 fact_id, check_uri, compiled_digest, fact_index, capability,
                 action_contract_digest, observed_at, payload_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              fact.id,
              fact.checkUri,
              fact.compiledCheckDigest,
              fact.index,
              fact.capability,
              fact.actionContractDigest,
              fact.observedAt,
              JSON.stringify(fact.payload),
            );
        }

        this.dependencies.databaseDriver
          .prepare(
            `INSERT INTO execution_fact_receipts (
               execution_handle, fact_id, fact_index, recorded_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(fact.executionHandle, fact.id, fact.index, fact.recordedAt);
        acceptedIds.push(fact.id);
      }
      return { acceptedIds, duplicateIds };
    });
  }

  findAtIndex(executionHandle: string, index: number): Fact | undefined {
    const row = this.dependencies.databaseDriver
      .prepare(
        `SELECT f.fact_id, f.check_uri, f.compiled_digest, r.fact_index,
                f.capability, f.action_contract_digest, f.observed_at, f.payload_json,
                r.execution_handle, r.recorded_at
           FROM execution_fact_receipts r
           JOIN facts f ON f.fact_id = r.fact_id
          WHERE r.execution_handle = ? AND r.fact_index = ?`,
      )
      .get<ReceivedFactRow>(executionHandle, index);
    return row ? toReceivedFact(row) : undefined;
  }

  listForExecution(executionHandle: string): Fact[] {
    return this.dependencies.databaseDriver
      .prepare(
        `SELECT f.fact_id, f.check_uri, f.compiled_digest, r.fact_index,
                f.capability, f.action_contract_digest, f.observed_at, f.payload_json,
                r.execution_handle, r.recorded_at
           FROM execution_fact_receipts r
           JOIN facts f ON f.fact_id = r.fact_id
          WHERE r.execution_handle = ?
          ORDER BY r.fact_index`,
      )
      .all<ReceivedFactRow>(executionHandle)
      .map(toReceivedFact);
  }

  private findStored(factId: string): StoredFact | undefined {
    const row = this.dependencies.databaseDriver
      .prepare(
        `SELECT fact_id, check_uri, compiled_digest, fact_index, capability,
                action_contract_digest, observed_at, payload_json
           FROM facts
          WHERE fact_id = ?`,
      )
      .get<StoredFactRow>(factId);
    return row ? toStoredFact(row) : undefined;
  }
}

function sameSemanticFact(left: StoredFact, right: Fact): boolean {
  return left.id === right.id
    && left.checkUri === right.checkUri
    && left.compiledCheckDigest === right.compiledCheckDigest
    && left.index === right.index
    && left.capability === right.capability
    && left.actionContractDigest === right.actionContractDigest
    && left.observedAt === right.observedAt
    && canonicalJson(left.payload) === canonicalJson(right.payload);
}

/** Receipt time and execution correlation are not part of a Fact's durable identity. */
function sameReceivedFact(left: Fact, right: Fact): boolean {
  return left.executionHandle === right.executionHandle
    && left.index === right.index
    && sameSemanticFact(left, right);
}

function toStoredFact(row: StoredFactRow): StoredFact {
  return {
    id: row.fact_id,
    checkUri: row.check_uri,
    compiledCheckDigest: row.compiled_digest,
    index: row.fact_index,
    capability: row.capability,
    actionContractDigest: row.action_contract_digest,
    observedAt: row.observed_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function toReceivedFact(row: ReceivedFactRow): Fact {
  return {
    ...toStoredFact(row),
    executionHandle: row.execution_handle,
    recordedAt: row.recorded_at,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
