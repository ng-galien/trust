import type {
  ActiveCheckQualification,
  CheckSnapshot,
} from "../model.js";
import type { DatabaseDriver, DatabaseRow } from "./database.js";

interface SnapshotRow extends DatabaseRow {
  snapshot_id: string;
  attempt_handle: string;
  plan_slug: string;
  plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  state: CheckSnapshot["state"];
  verdict: CheckSnapshot["verdict"];
  reason_code: string;
  reason: string;
  fact_ids_json: string;
  checklist_delta_json: string;
  calculated_at: string;
}

interface ActiveQualificationRow extends DatabaseRow {
  plan_slug: string;
  plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  snapshot_id: string;
  activation_digest: string;
}

const SNAPSHOT_COLUMNS = `snapshot_id, attempt_handle, plan_slug, plan_revision, check_uri,
  compiled_digest, state, verdict, reason_code, reason, fact_ids_json, checklist_delta_json,
  calculated_at`;

export class SnapshotStore {
  constructor(private readonly dependencies: { databaseDriver: DatabaseDriver }) {}

  append(snapshot: CheckSnapshot): void {
    const existing = this.findEquivalent(
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
    this.dependencies.databaseDriver
      .prepare(
        `INSERT INTO check_snapshots (${SNAPSHOT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.attemptHandle,
        snapshot.planSlug,
        snapshot.planRevision,
        snapshot.checkUri,
        snapshot.compiledCheckDigest,
        snapshot.state,
        snapshot.verdict,
        snapshot.reasonCode,
        snapshot.reason,
        JSON.stringify(snapshot.factIds),
        JSON.stringify(snapshot.checklistDelta),
        snapshot.calculatedAt,
      );
  }

  findEquivalent(
    checkUri: string,
    compiledDigest: string,
    factIds: readonly string[],
  ): CheckSnapshot | undefined {
    const row = this.dependencies.databaseDriver
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS}
           FROM check_snapshots
          WHERE check_uri = ? AND compiled_digest = ? AND fact_ids_json = ?`,
      )
      .get<SnapshotRow>(checkUri, compiledDigest, JSON.stringify(factIds));
    return row ? toSnapshot(row) : undefined;
  }

  findLatest(checkUri: string): CheckSnapshot | undefined {
    const row = this.dependencies.databaseDriver
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS}
           FROM check_snapshots
          WHERE check_uri = ?
          ORDER BY rowid DESC
          LIMIT 1`,
      )
      .get<SnapshotRow>(checkUri);
    return row ? toSnapshot(row) : undefined;
  }

  listHistory(checkUri: string): CheckSnapshot[] {
    return this.dependencies.databaseDriver
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS}
           FROM check_snapshots
          WHERE check_uri = ?
          ORDER BY rowid`,
      )
      .all<SnapshotRow>(checkUri)
      .map(toSnapshot);
  }

  saveActiveForRevision(
    planSlug: string,
    planRevision: number,
    qualifications: readonly ActiveCheckQualification[],
  ): void {
    const insert = this.dependencies.databaseDriver.prepare(
      `INSERT INTO active_check_qualifications (
         plan_slug, plan_revision, check_uri, compiled_digest, snapshot_id, activation_digest
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const qualification of qualifications) {
      if (
        qualification.planSlug !== planSlug
        || qualification.planRevision !== planRevision
      ) {
        throw new Error("an active qualification must belong to its exact Plan revision");
      }
      insert.run(
        qualification.planSlug,
        qualification.planRevision,
        qualification.checkUri,
        qualification.compiledCheckDigest,
        qualification.snapshotId,
        qualification.activationDigest,
      );
    }
  }

  listActive(planSlug: string, planRevision: number): ActiveCheckQualification[] {
    return this.dependencies.databaseDriver
      .prepare(
        `SELECT plan_slug, plan_revision, check_uri, compiled_digest, snapshot_id,
                activation_digest
           FROM active_check_qualifications
          WHERE plan_slug = ? AND plan_revision = ?
          ORDER BY check_uri`,
      )
      .all<ActiveQualificationRow>(planSlug, planRevision)
      .map((row) => ({
        planSlug: row.plan_slug,
        planRevision: row.plan_revision,
        checkUri: row.check_uri,
        compiledCheckDigest: row.compiled_digest,
        snapshotId: row.snapshot_id,
        activationDigest: row.activation_digest,
      }));
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
