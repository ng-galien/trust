import type { ExternalPrincipal, IntentChainState, PlanMode } from "@trust/extension-sdk";
import type { Selectable } from "kysely";
import type { Database, PlanRevisionTable, PlanTable } from "../database/database.js";
import type { Plan, PlanCancellation, PlanCheck, PlanRevision } from "../model.js";
import { readOnce } from "./transaction.js";

type PlanRow = Selectable<PlanTable>;
type RevisionRow = Selectable<PlanRevisionTable>;

export interface PlanStoreDependencies {
  readonly database: Database;
}

export interface PlanListQuery {
  readonly creator?: ExternalPrincipal;
  readonly filter?: {
    readonly procedure?: string;
    readonly mode?: PlanMode;
    readonly cancelled?: boolean;
  };
  readonly after?: { readonly createdAt: string; readonly plan: string };
  readonly limit: number;
}

export type PlanRevisionHistoryEntry = Pick<
  PlanRevision,
  | "revision"
  | "definitionDigest"
  | "source"
  | "agentDeclarations"
  | "missionDeclarations"
  | "resolvedMissions"
  | "roleValues"
  | "importedValues"
  | "checkValues"
> & { readonly checkUris: readonly string[] };

/** Starts the reason recorded on a Plan that TRUST closes because it is no longer the current generation of its mission. */
export const SUPERSEDED_GENERATION_REASON = "No longer the current generation of its mission";

export class PlanStore {
  constructor(private readonly dependencies: PlanStoreDependencies) {}

  using(database: Database): PlanStore {
    return new PlanStore({ database });
  }

  async saveRevision(
    compiled: PlanRevision,
    compiledAt: string,
    creator: ExternalPrincipal | null = null,
  ): Promise<void> {
    const database = this.dependencies.database;
    const existingRow = await database
      .selectFrom("plans")
      .selectAll()
      .where("plan_slug", "=", compiled.planSlug)
      .executeTakeFirst();
    const existing = existingRow ? toPlan(existingRow) : undefined;
    if (
      existing &&
      (existing.procedure !== compiled.procedure ||
        existing.procedureVersion !== compiled.procedureVersion ||
        existing.environment !== compiled.environment ||
        existing.mode !== compiled.mode ||
        existing.intentChaining !== compiled.intentChaining ||
        canonicalJson(existing.metadata) !== canonicalJson(compiled.metadata) ||
        canonicalJson(existing.rootInputs) !== canonicalJson(compiled.rootInputs))
    ) {
      throw new Error("a Plan cannot change its identity, environment, mode, metadata or root inputs");
    }

    for (const check of compiled.checks) {
      if (check.planSlug !== compiled.planSlug || check.planRevision !== compiled.revision) {
        throw new Error("a Check must belong to its exact Plan revision");
      }
    }

    if (!existing) {
      if (compiled.revision !== 1) throw new Error("a Plan must start at revision 1");
      await database
        .insertInto("plans")
        .values({
          creator_issuer: creator?.issuer ?? null,
          creator_subject: creator?.subject ?? null,
          plan_slug: compiled.planSlug,
          procedure_name: compiled.procedure,
          procedure_version: compiled.procedureVersion,
          environment: compiled.environment,
          mode: compiled.mode,
          intent_chaining: compiled.intentChaining,
          intent_chain_state: compiled.intentChaining ? "NOT_STARTED" : "DISABLED",
          current_intent: null,
          current_intent_check_uri: null,
          current_intent_attempt_key: null,
          metadata_json: JSON.stringify(compiled.metadata),
          root_inputs_json: JSON.stringify(compiled.rootInputs),
          current_revision: compiled.revision,
          created_at: compiledAt,
        })
        .execute();
    } else if (compiled.revision !== existing.currentRevision + 1) {
      throw new Error("a Plan revision must advance monotonically by one");
    }

    await database
      .insertInto("plan_revisions")
      .values({
        resolved_procedure_json: JSON.stringify(compiled.resolvedProcedure),
        plan_slug: compiled.planSlug,
        revision: compiled.revision,
        definition_digest: compiled.definitionDigest,
        source: compiled.source,
        declarations_json: JSON.stringify(compiled.agentDeclarations),
        mission_declarations_json: JSON.stringify(compiled.missionDeclarations),
        resolved_missions_json: JSON.stringify(compiled.resolvedMissions),
        role_values_json: JSON.stringify(serializeRoleValues(compiled)),
        check_values_json: JSON.stringify(compiled.checkValues),
        invocations_json: JSON.stringify(compiled.invocations),
        compiled_at: compiledAt,
      })
      .execute();

    if (compiled.checks.length > 0) {
      await database
        .insertInto("compiled_checks")
        .values(
          compiled.checks.map((check) => ({
            plan_slug: compiled.planSlug,
            plan_revision: compiled.revision,
            check_uri: check.uri,
            compiled_digest: check.compiledCheckDigest,
            check_json: JSON.stringify(check),
          })),
        )
        .execute();
    }

    if (existing) {
      const advanced = await database
        .updateTable("plans")
        .set({ current_revision: compiled.revision })
        .where("plan_slug", "=", compiled.planSlug)
        .where("current_revision", "=", existing.currentRevision)
        .executeTakeFirst();
      if (advanced.numUpdatedRows !== 1n) {
        throw new Error("the current Plan revision changed while it was being advanced");
      }
    }
  }

  /** Erase a Plan and everything it owns (revisions, checks, sessions, attempts, receipts, snapshots, active
      qualifications), in dependency order. Facts are content-addressed history and are kept. */
  async remove(planSlug: string): Promise<void> {
    const database = this.dependencies.database;
    await database.deleteFrom("plan_escalations").where("plan_slug", "=", planSlug).execute();
    await database.deleteFrom("active_check_qualifications").where("plan_slug", "=", planSlug).execute();
    await database.deleteFrom("check_snapshots").where("plan_slug", "=", planSlug).execute();
    await database.deleteFrom("attempts").where("plan_slug", "=", planSlug).execute();
    await database.deleteFrom("plans").where("plan_slug", "=", planSlug).execute();
  }

  findPlan(planSlug: string): Promise<Plan | undefined> {
    return readOnce(this.dependencies.database, `plan:${planSlug}`, () => this.#findPlan(planSlug));
  }

  async #findPlan(planSlug: string): Promise<Plan | undefined> {
    const row = await this.dependencies.database
      .selectFrom("plans")
      .selectAll()
      .where("plan_slug", "=", planSlug)
      .executeTakeFirst();
    return row ? toPlan(row) : undefined;
  }

  findCancellation(planSlug: string): Promise<PlanCancellation | undefined> {
    return readOnce(this.dependencies.database, `cancellation:${planSlug}`, () => this.#findCancellation(planSlug));
  }

  async #findCancellation(planSlug: string): Promise<PlanCancellation | undefined> {
    const row = await this.dependencies.database
      .selectFrom("plan_cancellations")
      .selectAll()
      .where("plan_slug", "=", planSlug)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      planSlug: row.plan_slug,
      rootPlan: row.root_plan,
      cancelledAt: row.cancelled_at,
      cancelledBy:
        row.actor_issuer === null || row.actor_subject === null
          ? null
          : { issuer: row.actor_issuer, subject: row.actor_subject },
      reason: row.reason,
    };
  }

  /**
   * The missions of a Plan that were stopped with a reason, oldest first: each child generation whose child Plan
   * carries a cancellation of its own (not one inherited from a cancelled root), with the mission it ran.
   */
  async listStoppedMissions(
    planSlug: string,
  ): Promise<{ collection: string; mission: string; cancellation: PlanCancellation }[]> {
    const database = this.dependencies.database;
    const stopped = await database
      .selectFrom("child_generations")
      .innerJoin("plan_cancellations", "plan_cancellations.plan_slug", "child_generations.child_plan")
      .select([
        "child_generations.invocation_id",
        "child_generations.child_plan",
        "plan_cancellations.root_plan",
        "plan_cancellations.cancelled_at",
        "plan_cancellations.actor_issuer",
        "plan_cancellations.actor_subject",
        "plan_cancellations.reason",
      ])
      .where("child_generations.parent_plan", "=", planSlug)
      .whereRef("plan_cancellations.root_plan", "=", "child_generations.child_plan")
      .orderBy("plan_cancellations.cancelled_at")
      .orderBy("child_generations.child_plan")
      .execute();
    if (stopped.length === 0) return [];
    const revisions = await database
      .selectFrom("plan_revisions")
      .select("invocations_json")
      .where("plan_slug", "=", planSlug)
      .orderBy("revision")
      .execute();
    const missions = new Map<string, { collection: string; id: string }>();
    for (const revision of revisions) {
      for (const invocation of revision.invocations_json as PlanRevision["invocations"]) {
        if (invocation.mission) missions.set(invocation.id, invocation.mission);
      }
    }
    return stopped.flatMap((row) => {
      const mission = missions.get(row.invocation_id);
      // A generation closed because it is no longer current was not stopped by an operator.
      if (!mission || row.reason.startsWith(SUPERSEDED_GENERATION_REASON)) return [];
      return [
        {
          collection: mission.collection,
          mission: mission.id,
          cancellation: {
            planSlug: row.child_plan,
            rootPlan: row.root_plan,
            cancelledAt: row.cancelled_at,
            cancelledBy:
              row.actor_issuer === null || row.actor_subject === null
                ? null
                : { issuer: row.actor_issuer, subject: row.actor_subject },
            reason: row.reason,
          },
        },
      ];
    });
  }

  async saveCancellation(cancellation: PlanCancellation): Promise<void> {
    await this.dependencies.database
      .insertInto("plan_cancellations")
      .values({
        plan_slug: cancellation.planSlug,
        root_plan: cancellation.rootPlan,
        cancelled_at: cancellation.cancelledAt,
        actor_issuer: cancellation.cancelledBy?.issuer ?? null,
        actor_subject: cancellation.cancelledBy?.subject ?? null,
        reason: cancellation.reason,
      })
      .execute();
  }

  /** Lock the expected current Plan row without producing a new tuple. */
  async lockCurrentRevision(planSlug: string, revision: number): Promise<boolean> {
    const result = await this.dependencies.database
      .selectFrom("plans")
      .select("plan_slug")
      .where("plan_slug", "=", planSlug)
      .where("current_revision", "=", revision)
      .forUpdate()
      .executeTakeFirst();
    return result !== undefined;
  }

  async initializeIntent(planSlug: string, intent: string): Promise<Plan> {
    await this.dependencies.database
      .updateTable("plans")
      .set({
        intent_chain_state: "ACTIVE",
        current_intent: intent,
        current_intent_check_uri: null,
        current_intent_attempt_key: null,
      })
      .where("plan_slug", "=", planSlug)
      .where("intent_chaining", "=", true)
      .where("intent_chain_state", "=", "NOT_STARTED")
      .execute();
    const plan = await this.findPlan(planSlug);
    if (!plan) throw new Error(`Unknown Plan: ${planSlug}`);
    return plan;
  }

  async advanceIntent(
    planSlug: string,
    currentIntent: string,
    nextIntent: string | undefined,
    complete: boolean,
    attemptKey: string,
  ): Promise<void> {
    const result = await this.dependencies.database
      .updateTable("plans")
      .set({
        intent_chain_state: complete ? "COMPLETE" : "ACTIVE",
        current_intent: complete ? null : (nextIntent ?? null),
        current_intent_check_uri: null,
        current_intent_attempt_key: null,
      })
      .where("plan_slug", "=", planSlug)
      .where("intent_chaining", "=", true)
      .where("intent_chain_state", "=", "ACTIVE")
      .where("current_intent", "=", currentIntent)
      .where("current_intent_attempt_key", "=", attemptKey)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error("the current Plan intent changed while it was being advanced");
  }

  async bindIntentAttempt(
    planSlug: string,
    currentIntent: string,
    checkUri: string,
    attemptKey: string,
    planRevision: number,
  ): Promise<boolean> {
    const result = await this.dependencies.database
      .updateTable("plans")
      .set({ current_intent_check_uri: checkUri, current_intent_attempt_key: attemptKey })
      .where("plan_slug", "=", planSlug)
      .where("intent_chain_state", "=", "ACTIVE")
      .where("current_intent", "=", currentIntent)
      .where("current_revision", "=", planRevision)
      .where("current_intent_check_uri", "is", null)
      .where("current_intent_attempt_key", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async releaseIntentAttempt(planSlug: string, currentIntent: string, attemptKey: string): Promise<void> {
    const result = await this.dependencies.database
      .updateTable("plans")
      .set({ current_intent_check_uri: null, current_intent_attempt_key: null })
      .where("plan_slug", "=", planSlug)
      .where("intent_chain_state", "=", "ACTIVE")
      .where("current_intent", "=", currentIntent)
      .where("current_intent_attempt_key", "=", attemptKey)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error("the current Plan intent is not reserved by this Attempt");
  }

  async restartIntent(planSlug: string): Promise<void> {
    await this.dependencies.database
      .updateTable("plans")
      .set({
        intent_chain_state: "NOT_STARTED",
        current_intent: null,
        current_intent_check_uri: null,
        current_intent_attempt_key: null,
      })
      .where("plan_slug", "=", planSlug)
      .where("intent_chaining", "=", true)
      .where("intent_chain_state", "=", "COMPLETE")
      .execute();
  }

  async restartIntentForAttempt(
    planSlug: string,
    intent: string,
    checkUri: string,
    attemptKey: string,
    planRevision: number,
  ): Promise<boolean> {
    const result = await this.dependencies.database
      .updateTable("plans")
      .set({
        intent_chain_state: "ACTIVE",
        current_intent: intent,
        current_intent_check_uri: checkUri,
        current_intent_attempt_key: attemptKey,
      })
      .where("plan_slug", "=", planSlug)
      .where("intent_chaining", "=", true)
      .where("intent_chain_state", "=", "COMPLETE")
      .where("current_revision", "=", planRevision)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async completeIntentWithoutAttempt(planSlug: string): Promise<void> {
    const result = await this.dependencies.database
      .updateTable("plans")
      .set({
        intent_chain_state: "COMPLETE",
        current_intent: null,
        current_intent_check_uri: null,
        current_intent_attempt_key: null,
      })
      .where("plan_slug", "=", planSlug)
      .where("intent_chaining", "=", true)
      .where("intent_chain_state", "in", ["NOT_STARTED", "ACTIVE"])
      .where("current_intent_check_uri", "is", null)
      .where("current_intent_attempt_key", "is", null)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n)
      throw new Error("the current Plan intent cannot complete while an Attempt is pending");
  }

  async listPlans(query: PlanListQuery): Promise<Plan[]> {
    let selection = this.dependencies.database
      .selectFrom("plans")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("plan_slug", "asc")
      .limit(query.limit);
    if (query.creator) {
      selection = selection
        .where("creator_issuer", "=", query.creator.issuer)
        .where("creator_subject", "=", query.creator.subject);
    }
    if (query.filter?.procedure !== undefined) {
      selection = selection.where("procedure_name", "=", query.filter.procedure);
    }
    if (query.filter?.mode !== undefined) {
      selection = selection.where("mode", "=", query.filter.mode);
    }
    if (query.filter?.cancelled !== undefined) {
      const cancelled = query.filter.cancelled;
      selection = selection.where(({ exists, not, selectFrom }) => {
        const cancellation = exists(
          selectFrom("plan_cancellations")
            .select("plan_cancellations.plan_slug")
            .whereRef("plan_cancellations.plan_slug", "=", "plans.plan_slug"),
        );
        return cancelled ? cancellation : not(cancellation);
      });
    }
    if (query.after !== undefined) {
      selection = selection.where((expression) =>
        expression.or([
          expression("created_at", "<", query.after!.createdAt),
          expression.and([
            expression("created_at", "=", query.after!.createdAt),
            expression("plan_slug", ">", query.after!.plan),
          ]),
        ]),
      );
    }
    const rows = await selection.execute();
    return rows.map(toPlan);
  }

  /** Revision history in two queries: only the recorded fields and the compiled Check URIs, newest first. */
  async listRevisions(planSlug: string): Promise<PlanRevisionHistoryEntry[]> {
    const [rows, checks] = await Promise.all([
      this.dependencies.database
        .selectFrom("plan_revisions")
        .select([
          "revision",
          "definition_digest",
          "source",
          "declarations_json",
          "mission_declarations_json",
          "resolved_missions_json",
          "role_values_json",
          "check_values_json",
        ])
        .where("plan_slug", "=", planSlug)
        .orderBy("revision", "desc")
        .execute(),
      this.dependencies.database
        .selectFrom("compiled_checks")
        .select(["plan_revision", "check_uri"])
        .where("plan_slug", "=", planSlug)
        .orderBy("check_uri")
        .execute(),
    ]);
    const checkUris = new Map<number, string[]>();
    for (const { plan_revision, check_uri } of checks) {
      const uris = checkUris.get(plan_revision) ?? [];
      uris.push(check_uri);
      checkUris.set(plan_revision, uris);
    }
    return rows.map((row) => {
      const values = parseRoleValues(row.role_values_json);
      return {
        revision: row.revision,
        definitionDigest: row.definition_digest,
        source: row.source,
        agentDeclarations: row.declarations_json as PlanRevision["agentDeclarations"],
        missionDeclarations: row.mission_declarations_json as PlanRevision["missionDeclarations"],
        resolvedMissions: row.resolved_missions_json as PlanRevision["resolvedMissions"],
        roleValues: values.produced,
        importedValues: values.imported,
        checkValues: row.check_values_json as PlanRevision["checkValues"],
        checkUris: checkUris.get(row.revision) ?? [],
      };
    });
  }

  async findCurrentCheck(checkUri: string): Promise<PlanCheck | undefined> {
    const row = await this.dependencies.database
      .selectFrom("compiled_checks")
      .innerJoin("plans", "plans.plan_slug", "compiled_checks.plan_slug")
      .select("compiled_checks.check_json")
      .where("compiled_checks.check_uri", "=", checkUri)
      .whereRef("compiled_checks.plan_revision", "=", "plans.current_revision")
      .executeTakeFirst();
    return row ? (row.check_json as PlanCheck) : undefined;
  }

  listCurrentChecks(planSlug: string): Promise<PlanCheck[]> {
    return readOnce(this.dependencies.database, `checks:${planSlug}`, () => this.#listCurrentChecks(planSlug));
  }

  async #listCurrentChecks(planSlug: string): Promise<PlanCheck[]> {
    const rows = await this.dependencies.database
      .selectFrom("compiled_checks")
      .innerJoin("plans", "plans.plan_slug", "compiled_checks.plan_slug")
      .select("compiled_checks.check_json")
      .where("plans.plan_slug", "=", planSlug)
      .whereRef("compiled_checks.plan_revision", "=", "plans.current_revision")
      .orderBy("compiled_checks.check_uri")
      .execute();
    return rows.map((row) => row.check_json as PlanCheck);
  }

  async findCheckAtRevision(planSlug: string, revision: number, checkUri: string): Promise<PlanCheck | undefined> {
    const row = await this.dependencies.database
      .selectFrom("compiled_checks")
      .select("check_json")
      .where("plan_slug", "=", planSlug)
      .where("plan_revision", "=", revision)
      .where("check_uri", "=", checkUri)
      .executeTakeFirst();
    return row ? (row.check_json as PlanCheck) : undefined;
  }

  readRevision(planSlug: string, revision: number): Promise<PlanRevision | undefined> {
    return readOnce(this.dependencies.database, `revision:${planSlug}:${revision}`, () =>
      this.#readRevision(planSlug, revision),
    );
  }

  async #readRevision(planSlug: string, revision: number): Promise<PlanRevision | undefined> {
    const [planRow, row, checkRows] = await Promise.all([
      this.dependencies.database.selectFrom("plans").selectAll().where("plan_slug", "=", planSlug).executeTakeFirst(),
      this.dependencies.database
        .selectFrom("plan_revisions")
        .selectAll()
        .where("plan_slug", "=", planSlug)
        .where("revision", "=", revision)
        .executeTakeFirst(),
      this.dependencies.database
        .selectFrom("compiled_checks")
        .select("check_json")
        .where("plan_slug", "=", planSlug)
        .where("plan_revision", "=", revision)
        .orderBy("check_uri")
        .execute(),
    ]);
    if (!planRow || !row) return undefined;
    return toRevision(
      toPlan(planRow),
      row,
      checkRows.map(({ check_json }) => check_json),
    );
  }
}

function toPlan(row: PlanRow): Plan {
  return {
    creator:
      row.creator_issuer === null || row.creator_subject === null
        ? null
        : { issuer: row.creator_issuer, subject: row.creator_subject },
    slug: row.plan_slug,
    procedure: row.procedure_name,
    procedureVersion: row.procedure_version,
    environment: row.environment,
    mode: row.mode as PlanMode,
    intentChaining: row.intent_chaining,
    intentChainState: row.intent_chain_state as IntentChainState,
    ...(row.current_intent === null ? {} : { currentIntent: row.current_intent }),
    ...(row.current_intent_check_uri === null ? {} : { currentIntentCheckUri: row.current_intent_check_uri }),
    ...(row.current_intent_attempt_key === null ? {} : { currentIntentAttemptKey: row.current_intent_attempt_key }),
    metadata: row.metadata_json as Plan["metadata"],
    rootInputs: row.root_inputs_json as Record<string, unknown>,
    currentRevision: row.current_revision,
    createdAt: row.created_at,
  };
}

function toRevision(plan: Plan, row: RevisionRow, checkJson: readonly PlanCheck[]): PlanRevision {
  const values = parseRoleValues(row.role_values_json);
  return {
    resolvedProcedure: row.resolved_procedure_json as PlanRevision["resolvedProcedure"],
    procedure: plan.procedure,
    procedureVersion: plan.procedureVersion,
    environment: plan.environment,
    mode: plan.mode,
    intentChaining: plan.intentChaining,
    metadata: plan.metadata,
    rootInputs: plan.rootInputs,
    planSlug: plan.slug,
    revision: row.revision,
    definitionDigest: row.definition_digest,
    source: row.source,
    agentDeclarations: row.declarations_json as PlanRevision["agentDeclarations"],
    missionDeclarations: row.mission_declarations_json as PlanRevision["missionDeclarations"],
    resolvedMissions: row.resolved_missions_json as PlanRevision["resolvedMissions"],
    roleValues: values.produced,
    importedValues: values.imported,
    checkValues: row.check_values_json as PlanRevision["checkValues"],
    invocations: row.invocations_json as PlanRevision["invocations"],
    checks: checkJson,
  };
}

function serializeRoleValues(revision: PlanRevision): unknown {
  if (revision.importedValues.length === 0) return revision.roleValues;
  return {
    contract: "trust.plan-role-values@1",
    produced: revision.roleValues,
    imported: revision.importedValues,
  };
}

function parseRoleValues(parsed: unknown): {
  readonly produced: PlanRevision["roleValues"];
  readonly imported: PlanRevision["importedValues"];
} {
  if (Array.isArray(parsed)) return { produced: parsed as PlanRevision["roleValues"], imported: [] };
  if (parsed === null || typeof parsed !== "object") throw new TypeError("Plan revision has invalid role values");
  const record = parsed as Record<string, unknown>;
  if (
    record.contract !== "trust.plan-role-values@1" ||
    !Array.isArray(record.produced) ||
    !Array.isArray(record.imported)
  )
    throw new TypeError("Plan revision has invalid role values");
  return {
    produced: record.produced as PlanRevision["roleValues"],
    imported: record.imported as PlanRevision["importedValues"],
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
