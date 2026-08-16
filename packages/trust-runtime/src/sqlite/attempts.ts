import type { Attempt } from "../model.js";
import type { DatabaseDriver, DatabaseRow } from "./database.js";

interface AttemptRow extends DatabaseRow {
  attempt_handle: string;
  attempt_key: string;
  plan_slug: string;
  plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  session_id: string;
  operation: string;
  operation_digest: string;
  action_input_json: string;
  environment: string;
  owner_json: string;
  state: Attempt["state"];
  admitted_at: string;
  expires_at: string;
  finalized_at: string | null;
  finalization_json: string | null;
}

const COLUMNS = `attempt_handle, attempt_key, plan_slug, plan_revision, check_uri,
  compiled_digest, session_id, operation, operation_digest, action_input_json,
  environment, owner_json,
  state, admitted_at, expires_at, finalized_at, finalization_json`;

export class AttemptStore {
  readonly #database: DatabaseDriver;

  constructor({ databaseDriver }: { readonly databaseDriver: DatabaseDriver }) {
    this.#database = databaseDriver;
  }

  create(attempt: Attempt): void {
    this.#database.prepare(
      `INSERT INTO attempts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attempt.handle,
      attempt.attemptKey,
      attempt.planSlug,
      attempt.planRevision,
      attempt.checkUri,
      attempt.compiledCheckDigest,
      attempt.sessionId,
      attempt.operation,
      attempt.operationDigest,
      JSON.stringify(attempt.actionInput),
      attempt.environment,
      JSON.stringify(attempt.owner),
      attempt.state,
      attempt.admittedAt,
      attempt.expiresAt,
      attempt.finalizedAt ?? null,
      attempt.finalization === undefined ? null : JSON.stringify(attempt.finalization),
    );
  }

  findByKey(attemptKey: string): Attempt | undefined {
    const row = this.#database.prepare(`SELECT ${COLUMNS} FROM attempts WHERE attempt_key = ?`)
      .get<AttemptRow>(attemptKey);
    return row ? toAttempt(row) : undefined;
  }

  find(handle: string): Attempt | undefined {
    const row = this.#database.prepare(`SELECT ${COLUMNS} FROM attempts WHERE attempt_handle = ?`)
      .get<AttemptRow>(handle);
    return row ? toAttempt(row) : undefined;
  }

  listByCheck(checkUri: string): Attempt[] {
    return this.#database
      .prepare(
        `SELECT ${COLUMNS}
           FROM attempts
          WHERE check_uri = ?
          ORDER BY admitted_at DESC, attempt_handle`,
      )
      .all<AttemptRow>(checkUri)
      .map(toAttempt);
  }

  finalize(handle: string, finalizedAt: string, finalization: NonNullable<Attempt["finalization"]>): void {
    const result = this.#database.prepare(
      "UPDATE attempts SET state = 'finalized', finalized_at = ?, finalization_json = ? WHERE attempt_handle = ? AND state = 'pending'",
    ).run(finalizedAt, JSON.stringify(finalization), handle);
    if (Number(result.changes) !== 1) throw new Error(`Unknown attempt: ${handle}`);
  }
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    handle: row.attempt_handle,
    attemptKey: row.attempt_key,
    planSlug: row.plan_slug,
    planRevision: row.plan_revision,
    checkUri: row.check_uri,
    compiledCheckDigest: row.compiled_digest,
    sessionId: row.session_id,
    operation: row.operation,
    operationDigest: row.operation_digest,
    actionInput: JSON.parse(row.action_input_json) as Record<string, unknown>,
    environment: row.environment,
    owner: JSON.parse(row.owner_json) as Attempt["owner"],
    state: row.state,
    admittedAt: row.admitted_at,
    expiresAt: row.expires_at,
    ...(row.finalized_at ? { finalizedAt: row.finalized_at } : {}),
    ...(row.finalization_json
      ? { finalization: JSON.parse(row.finalization_json) as NonNullable<Attempt["finalization"]> }
      : {}),
  };
}
