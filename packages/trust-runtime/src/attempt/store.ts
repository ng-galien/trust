import type { Selectable } from "kysely";

import type { AttemptTable, Database } from "../database/database.js";
import type { Attempt } from "../model.js";

type AttemptRow = Selectable<AttemptTable>;

export interface AttemptCreation {
  readonly attempt: Attempt;
  readonly created: boolean;
}

export class AttemptStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  using(database: Database): AttemptStore {
    return new AttemptStore({ database });
  }

  async createOrFind(attempt: Attempt): Promise<AttemptCreation> {
    const created = await this.dependencies.database.insertInto("attempts").values({
      attempt_handle: attempt.handle,
      attempt_key: attempt.attemptKey,
      execution_id: attempt.executionId,
      plan_slug: attempt.planSlug,
      plan_revision: attempt.planRevision,
      check_uri: attempt.checkUri,
      compiled_digest: attempt.compiledCheckDigest,
      session_id: attempt.sessionId,
      operation: attempt.operation,
      operation_digest: attempt.operationDigest,
      action_input_json: JSON.stringify(attempt.actionInput),
      environment: attempt.environment,
      reobserve: attempt.reobserve ? 1 : 0,
      intent: attempt.intent ?? null,
      next_intent: attempt.nextIntent ?? null,
      state: attempt.state,
      admitted_at: attempt.admittedAt,
      expires_at: attempt.expiresAt,
      interrupted_at: attempt.interruptedAt ?? null,
      finalized_at: attempt.finalizedAt ?? null,
      finalization_json: attempt.finalization === undefined ? null : JSON.stringify(attempt.finalization),
    })
      .onConflict((conflict) => conflict.column("attempt_key").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (created) return { attempt: toAttempt(created), created: true };

    const existing = await this.findByKey(attempt.attemptKey);
    if (!existing) throw new Error(`Attempt ${attempt.attemptKey} was not created and cannot be read`);
    return { attempt: existing, created: false };
  }

  async lockPending(handle: string): Promise<Attempt | undefined> {
    const row = await this.dependencies.database
      .updateTable("attempts")
      .set({ state: "pending" })
      .where("attempt_handle", "=", handle)
      .where("state", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    return row ? toAttempt(row) : undefined;
  }

  async findByKey(attemptKey: string): Promise<Attempt | undefined> {
    const row = await this.dependencies.database
      .selectFrom("attempts")
      .selectAll()
      .where("attempt_key", "=", attemptKey)
      .executeTakeFirst();
    return row ? toAttempt(row) : undefined;
  }

  async find(handle: string): Promise<Attempt | undefined> {
    const row = await this.dependencies.database
      .selectFrom("attempts")
      .selectAll()
      .where("attempt_handle", "=", handle)
      .executeTakeFirst();
    return row ? toAttempt(row) : undefined;
  }

  async listByCheck(checkUri: string): Promise<Attempt[]> {
    const rows = await this.dependencies.database
      .selectFrom("attempts")
      .selectAll()
      .where("check_uri", "=", checkUri)
      .orderBy("admitted_at", "desc")
      .orderBy("attempt_handle")
      .execute();
    return rows.map(toAttempt);
  }

  async finalize(
    handle: string,
    finalizedAt: string,
    finalization: NonNullable<Attempt["finalization"]>,
  ): Promise<void> {
    const result = await this.dependencies.database
      .updateTable("attempts")
      .set({
        state: "finalized",
        finalized_at: finalizedAt,
        finalization_json: JSON.stringify(finalization),
      })
      .where("attempt_handle", "=", handle)
      .where("state", "=", "pending")
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error(`Unknown attempt: ${handle}`);
  }

  async interrupt(handle: string, interruptedAt: string): Promise<void> {
    const result = await this.dependencies.database
      .updateTable("attempts")
      .set({ state: "interrupted", interrupted_at: interruptedAt })
      .where("attempt_handle", "=", handle)
      .where("state", "=", "pending")
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error(`Unknown pending attempt: ${handle}`);
  }
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    handle: row.attempt_handle,
    attemptKey: row.attempt_key,
    executionId: row.execution_id,
    planSlug: row.plan_slug,
    planRevision: row.plan_revision,
    checkUri: row.check_uri,
    compiledCheckDigest: row.compiled_digest,
    sessionId: row.session_id,
    operation: row.operation,
    operationDigest: row.operation_digest,
    actionInput: JSON.parse(row.action_input_json) as Record<string, unknown>,
    environment: row.environment,
    reobserve: row.reobserve === 1,
    ...(row.intent === null ? {} : { intent: row.intent }),
    ...(row.next_intent === null ? {} : { nextIntent: row.next_intent }),
    state: row.state,
    admittedAt: row.admitted_at,
    expiresAt: row.expires_at,
    ...(row.interrupted_at ? { interruptedAt: row.interrupted_at } : {}),
    ...(row.finalized_at ? { finalizedAt: row.finalized_at } : {}),
    ...(row.finalization_json
      ? { finalization: JSON.parse(row.finalization_json) as NonNullable<Attempt["finalization"]> }
      : {}),
  };
}
