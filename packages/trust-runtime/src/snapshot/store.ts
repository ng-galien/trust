import type { Selectable } from "kysely";

import type {
  ActiveCheckQualificationTable,
  CheckSnapshotTable,
  Database,
} from "../database/database.js";
import type { ActiveCheckQualification, CheckSnapshot } from "../model.js";

type SnapshotRow = Selectable<CheckSnapshotTable>;
type ActiveQualificationRow = Selectable<ActiveCheckQualificationTable>;

export class SnapshotStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  using(database: Database): SnapshotStore {
    return new SnapshotStore({ database });
  }

  async append(snapshot: CheckSnapshot): Promise<void> {
    const existing = await this.findEquivalent(
      snapshot.checkUri,
      snapshot.compiledCheckDigest,
      snapshot.factIds,
    );
    if (existing) {
      if (!sameQualification(existing, snapshot)) {
        throw new Error(`Check Snapshot collision: ${snapshot.id}`);
      }
      return;
    }
    await this.dependencies.database.insertInto("check_snapshots").values({
      snapshot_id: snapshot.id,
      attempt_handle: snapshot.attemptHandle,
      plan_slug: snapshot.planSlug,
      plan_revision: snapshot.planRevision,
      check_uri: snapshot.checkUri,
      compiled_digest: snapshot.compiledCheckDigest,
      state: snapshot.state,
      verdict: snapshot.verdict,
      reason_code: snapshot.reasonCode,
      reason: snapshot.reason,
      fact_ids_json: JSON.stringify(snapshot.factIds),
      checklist_delta_json: JSON.stringify(snapshot.checklistDelta),
      calculated_at: snapshot.calculatedAt,
    }).execute();
  }

  async findEquivalent(
    checkUri: string,
    compiledDigest: string,
    factIds: readonly string[],
  ): Promise<CheckSnapshot | undefined> {
    const row = await this.dependencies.database
      .selectFrom("check_snapshots")
      .selectAll()
      .where("check_uri", "=", checkUri)
      .where("compiled_digest", "=", compiledDigest)
      .where("fact_ids_json", "=", JSON.stringify(factIds))
      .executeTakeFirst();
    return row ? toSnapshot(row) : undefined;
  }

  async findLatest(checkUri: string): Promise<CheckSnapshot | undefined> {
    const row = await this.dependencies.database
      .selectFrom("check_snapshots")
      .selectAll()
      .where("check_uri", "=", checkUri)
      .orderBy("calculated_at", "desc")
      .orderBy("snapshot_id", "desc")
      .executeTakeFirst();
    return row ? toSnapshot(row) : undefined;
  }

  async listHistory(checkUri: string): Promise<CheckSnapshot[]> {
    const rows = await this.dependencies.database
      .selectFrom("check_snapshots")
      .selectAll()
      .where("check_uri", "=", checkUri)
      .orderBy("calculated_at")
      .orderBy("snapshot_id")
      .execute();
    return rows.map(toSnapshot);
  }

  async saveActiveForRevision(
    planSlug: string,
    planRevision: number,
    qualifications: readonly ActiveCheckQualification[],
  ): Promise<void> {
    for (const qualification of qualifications) {
      if (qualification.planSlug !== planSlug || qualification.planRevision !== planRevision) {
        throw new Error("an active qualification must belong to its exact Plan revision");
      }
    }
    if (qualifications.length === 0) return;
    await this.dependencies.database.insertInto("active_check_qualifications").values(
      qualifications.map((qualification) => ({
        plan_slug: qualification.planSlug,
        plan_revision: qualification.planRevision,
        check_uri: qualification.checkUri,
        compiled_digest: qualification.compiledCheckDigest,
        snapshot_id: qualification.snapshotId,
        activation_digest: qualification.activationDigest,
      })),
    ).execute();
  }

  async listActive(planSlug: string, planRevision: number): Promise<ActiveCheckQualification[]> {
    const rows = await this.dependencies.database
      .selectFrom("active_check_qualifications")
      .selectAll()
      .where("plan_slug", "=", planSlug)
      .where("plan_revision", "=", planRevision)
      .orderBy("check_uri")
      .execute();
    return rows.map(toActiveQualification);
  }
}

function sameQualification(left: CheckSnapshot, right: CheckSnapshot): boolean {
  return left.planSlug === right.planSlug
    && left.planRevision === right.planRevision
    && left.checkUri === right.checkUri
    && left.compiledCheckDigest === right.compiledCheckDigest
    && left.state === right.state
    && left.verdict === right.verdict
    && left.reasonCode === right.reasonCode
    && left.reason === right.reason
    && JSON.stringify(left.factIds) === JSON.stringify(right.factIds)
    && JSON.stringify(left.checklistDelta) === JSON.stringify(right.checklistDelta);
}

function toSnapshot(row: SnapshotRow): CheckSnapshot {
  return {
    id: row.snapshot_id,
    attemptHandle: row.attempt_handle,
    planSlug: row.plan_slug,
    planRevision: row.plan_revision,
    checkUri: row.check_uri,
    compiledCheckDigest: row.compiled_digest,
    state: row.state,
    verdict: row.verdict,
    reasonCode: row.reason_code,
    reason: row.reason,
    factIds: JSON.parse(row.fact_ids_json) as string[],
    checklistDelta: JSON.parse(row.checklist_delta_json) as CheckSnapshot["checklistDelta"],
    calculatedAt: row.calculated_at,
  };
}

function toActiveQualification(row: ActiveQualificationRow): ActiveCheckQualification {
  return {
    planSlug: row.plan_slug,
    planRevision: row.plan_revision,
    checkUri: row.check_uri,
    compiledCheckDigest: row.compiled_digest,
    snapshotId: row.snapshot_id,
    activationDigest: row.activation_digest,
  };
}
