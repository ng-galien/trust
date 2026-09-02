import type { Selectable } from "kysely";

import type { Database, PlanEscalationTable } from "../database/database.js";
import type { PlanEscalation } from "../model.js";

type EscalationRow = Selectable<PlanEscalationTable>;

export class EscalationStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  using(database: Database): EscalationStore {
    return new EscalationStore({ database });
  }

  async create(escalation: PlanEscalation): Promise<void> {
    await this.dependencies.database.insertInto("plan_escalations").values({
      escalation_id: escalation.id,
      plan_slug: escalation.planSlug,
      plan_revision: escalation.planRevision,
      snapshot_plan_revision: escalation.snapshotPlanRevision,
      check_uri: escalation.checkUri,
      compiled_digest: escalation.compiledCheckDigest,
      snapshot_id: escalation.snapshotId,
      attempt_handle: escalation.attemptHandle,
      blocking_reason: escalation.blockingReason,
      forbidden_further_action: escalation.forbiddenFurtherAction,
      escalated_at: escalation.escalatedAt,
      resumed_at: escalation.resumedAt ?? null,
      resume_reason: escalation.resumeReason ?? null,
    }).execute();
  }

  async findActive(planSlug: string): Promise<PlanEscalation | undefined> {
    const row = await this.dependencies.database
      .selectFrom("plan_escalations")
      .selectAll()
      .where("plan_slug", "=", planSlug)
      .where("resumed_at", "is", null)
      .executeTakeFirst();
    return row ? toEscalation(row) : undefined;
  }

  async find(escalationId: string): Promise<PlanEscalation | undefined> {
    const row = await this.dependencies.database
      .selectFrom("plan_escalations")
      .selectAll()
      .where("escalation_id", "=", escalationId)
      .executeTakeFirst();
    return row ? toEscalation(row) : undefined;
  }

  async findByAttempt(attemptHandle: string): Promise<PlanEscalation | undefined> {
    const row = await this.dependencies.database
      .selectFrom("plan_escalations")
      .selectAll()
      .where("attempt_handle", "=", attemptHandle)
      .executeTakeFirst();
    return row ? toEscalation(row) : undefined;
  }

  async listForPlan(planSlug: string): Promise<PlanEscalation[]> {
    const rows = await this.dependencies.database
      .selectFrom("plan_escalations")
      .selectAll()
      .where("plan_slug", "=", planSlug)
      .orderBy("escalated_at")
      .orderBy("escalation_id")
      .execute();
    return rows.map(toEscalation);
  }

  async resume(escalationId: string, resumedAt: string, resumeReason: string): Promise<PlanEscalation | undefined> {
    const row = await this.dependencies.database
      .updateTable("plan_escalations")
      .set({ resumed_at: resumedAt, resume_reason: resumeReason })
      .where("escalation_id", "=", escalationId)
      .where("resumed_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? toEscalation(row) : undefined;
  }
}

function toEscalation(row: EscalationRow): PlanEscalation {
  return {
    id: row.escalation_id,
    planSlug: row.plan_slug,
    planRevision: row.plan_revision,
    snapshotPlanRevision: row.snapshot_plan_revision,
    checkUri: row.check_uri,
    compiledCheckDigest: row.compiled_digest,
    snapshotId: row.snapshot_id,
    attemptHandle: row.attempt_handle,
    blockingReason: row.blocking_reason,
    forbiddenFurtherAction: row.forbidden_further_action,
    escalatedAt: row.escalated_at,
    ...(row.resumed_at === null ? {} : { resumedAt: row.resumed_at }),
    ...(row.resume_reason === null ? {} : { resumeReason: row.resume_reason }),
  };
}
