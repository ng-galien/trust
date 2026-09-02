import type { Selectable } from "kysely";

import type { Database, PlanRevisionTable, PlanTable } from "../database/database.js";
import type { IntentChainState, Plan, PlanCheck, PlanMode, PlanRevision } from "../model.js";

type PlanRow = Selectable<PlanTable>;
type RevisionRow = Selectable<PlanRevisionTable>;

export interface PlanStoreDependencies {
  readonly database: Database;
}

export interface PlanListQuery {
  readonly filter?: {
    readonly procedure?: string;
    readonly mode?: PlanMode;
  };
  readonly after?: { readonly createdAt: string; readonly plan: string };
  readonly limit: number;
}

export class PlanStore {
  constructor(private readonly dependencies: PlanStoreDependencies) {}

  using(database: Database): PlanStore {
    return new PlanStore({ database });
  }

  async saveRevision(compiled: PlanRevision, compiledAt: string): Promise<void> {
    const database = this.dependencies.database;
    const existingRow = await database
      .selectFrom("plans")
      .selectAll()
      .where("plan_slug", "=", compiled.planSlug)
      .executeTakeFirst();
    const existing = existingRow ? toPlan(existingRow) : undefined;
    if (
      existing
      && (existing.procedure !== compiled.procedure
        || existing.procedureVersion !== compiled.procedureVersion
        || existing.environment !== compiled.environment
        || existing.mode !== compiled.mode
        || existing.intentChaining !== compiled.intentChaining
        || canonicalJson(existing.rootInputs) !== canonicalJson(compiled.rootInputs))
    ) {
      throw new Error("a Plan cannot change its identity, environment, mode or root inputs");
    }

    for (const check of compiled.checks) {
      if (check.planSlug !== compiled.planSlug || check.planRevision !== compiled.revision) {
        throw new Error("a Check must belong to its exact Plan revision");
      }
    }

    if (!existing) {
      if (compiled.revision !== 1) throw new Error("a Plan must start at revision 1");
      await database.insertInto("plans").values({
        plan_slug: compiled.planSlug,
        procedure_name: compiled.procedure,
        procedure_version: compiled.procedureVersion,
        environment: compiled.environment,
        mode: compiled.mode,
        intent_chaining: compiled.intentChaining ? 1 : 0,
        intent_chain_state: compiled.intentChaining ? "NOT_STARTED" : "DISABLED",
        current_intent: null,
        current_intent_check_uri: null,
        current_intent_attempt_key: null,
        root_inputs_json: JSON.stringify(compiled.rootInputs),
        current_revision: compiled.revision,
        created_at: compiledAt,
      }).execute();
    } else if (compiled.revision !== existing.currentRevision + 1) {
      throw new Error("a Plan revision must advance monotonically by one");
    }

    await database.insertInto("plan_revisions").values({
      plan_slug: compiled.planSlug,
      revision: compiled.revision,
      definition_digest: compiled.definitionDigest,
      source: compiled.source,
      declarations_json: JSON.stringify(compiled.agentDeclarations),
      role_values_json: JSON.stringify(compiled.roleValues),
      check_values_json: JSON.stringify(compiled.checkValues),
      compiled_at: compiledAt,
    }).execute();

    if (compiled.checks.length > 0) {
      await database.insertInto("compiled_checks").values(compiled.checks.map((check) => ({
        plan_slug: compiled.planSlug,
        plan_revision: compiled.revision,
        check_uri: check.uri,
        compiled_digest: check.compiledCheckDigest,
        check_json: JSON.stringify(check),
      }))).execute();
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

  async findPlan(planSlug: string): Promise<Plan | undefined> {
    const row = await this.dependencies.database
      .selectFrom("plans")
      .selectAll()
      .where("plan_slug", "=", planSlug)
      .executeTakeFirst();
    return row ? toPlan(row) : undefined;
  }

  /** Acquire the Plan's SQLite write serialization point without changing its revision. */
  async lockCurrentRevision(planSlug: string, revision: number): Promise<boolean> {
    const result = await this.dependencies.database
      .updateTable("plans")
      .set({ current_revision: revision })
      .where("plan_slug", "=", planSlug)
      .where("current_revision", "=", revision)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
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
      .where("intent_chaining", "=", 1)
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
        current_intent: complete ? null : nextIntent ?? null,
        current_intent_check_uri: null,
        current_intent_attempt_key: null,
      })
      .where("plan_slug", "=", planSlug)
      .where("intent_chaining", "=", 1)
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
      .where("intent_chaining", "=", 1)
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
      .where("intent_chaining", "=", 1)
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
      .where("intent_chaining", "=", 1)
      .where("intent_chain_state", "in", ["NOT_STARTED", "ACTIVE"])
      .where("current_intent_check_uri", "is", null)
      .where("current_intent_attempt_key", "is", null)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Error("the current Plan intent cannot complete while an Attempt is pending");
  }

  async listPlans(query: PlanListQuery): Promise<Plan[]> {
    let selection = this.dependencies.database
      .selectFrom("plans")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("plan_slug", "asc")
      .limit(query.limit);
    if (query.filter?.procedure !== undefined) {
      selection = selection.where("procedure_name", "=", query.filter.procedure);
    }
    if (query.filter?.mode !== undefined) {
      selection = selection.where("mode", "=", query.filter.mode);
    }
    if (query.after !== undefined) {
      selection = selection.where((expression) => expression.or([
        expression("created_at", "<", query.after!.createdAt),
        expression.and([
          expression("created_at", "=", query.after!.createdAt),
          expression("plan_slug", ">", query.after!.plan),
        ]),
      ]));
    }
    const rows = await selection
      .execute();
    return rows.map(toPlan);
  }

  async listRevisions(planSlug: string): Promise<PlanRevision[]> {
    const rows = await this.dependencies.database
      .selectFrom("plan_revisions")
      .select("revision")
      .where("plan_slug", "=", planSlug)
      .orderBy("revision", "desc")
      .execute();
    const revisions = await Promise.all(rows.map(({ revision }) => this.readRevision(planSlug, revision)));
    return revisions.filter((revision): revision is PlanRevision => revision !== undefined);
  }

  async findCurrentCheck(checkUri: string): Promise<PlanCheck | undefined> {
    const row = await this.dependencies.database
      .selectFrom("compiled_checks")
      .innerJoin("plans", "plans.plan_slug", "compiled_checks.plan_slug")
      .select("compiled_checks.check_json")
      .where("compiled_checks.check_uri", "=", checkUri)
      .whereRef("compiled_checks.plan_revision", "=", "plans.current_revision")
      .executeTakeFirst();
    return row ? JSON.parse(row.check_json) as PlanCheck : undefined;
  }

  async listCurrentChecks(planSlug: string): Promise<PlanCheck[]> {
    const rows = await this.dependencies.database
      .selectFrom("compiled_checks")
      .innerJoin("plans", "plans.plan_slug", "compiled_checks.plan_slug")
      .select("compiled_checks.check_json")
      .where("plans.plan_slug", "=", planSlug)
      .whereRef("compiled_checks.plan_revision", "=", "plans.current_revision")
      .orderBy("compiled_checks.check_uri")
      .execute();
    return rows.map((row) => JSON.parse(row.check_json) as PlanCheck);
  }

  async findCheckAtRevision(
    planSlug: string,
    revision: number,
    checkUri: string,
  ): Promise<PlanCheck | undefined> {
    const row = await this.dependencies.database
      .selectFrom("compiled_checks")
      .select("check_json")
      .where("plan_slug", "=", planSlug)
      .where("plan_revision", "=", revision)
      .where("check_uri", "=", checkUri)
      .executeTakeFirst();
    return row ? JSON.parse(row.check_json) as PlanCheck : undefined;
  }

  async readRevision(planSlug: string, revision: number): Promise<PlanRevision | undefined> {
    const [planRow, row, checkRows] = await Promise.all([
      this.dependencies.database
        .selectFrom("plans")
        .selectAll()
        .where("plan_slug", "=", planSlug)
        .executeTakeFirst(),
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
    return toRevision(toPlan(planRow), row, checkRows.map(({ check_json }) => check_json));
  }
}

function toPlan(row: PlanRow): Plan {
  return {
    slug: row.plan_slug,
    procedure: row.procedure_name,
    procedureVersion: row.procedure_version,
    environment: row.environment,
    mode: row.mode as PlanMode,
    intentChaining: row.intent_chaining === 1,
    intentChainState: row.intent_chain_state as IntentChainState,
    ...(row.current_intent === null ? {} : { currentIntent: row.current_intent }),
    ...(row.current_intent_check_uri === null ? {} : { currentIntentCheckUri: row.current_intent_check_uri }),
    ...(row.current_intent_attempt_key === null ? {} : { currentIntentAttemptKey: row.current_intent_attempt_key }),
    rootInputs: JSON.parse(row.root_inputs_json) as Record<string, unknown>,
    currentRevision: row.current_revision,
    createdAt: row.created_at,
  };
}

function toRevision(plan: Plan, row: RevisionRow, checkJson: readonly string[]): PlanRevision {
  return {
    procedure: plan.procedure,
    procedureVersion: plan.procedureVersion,
    environment: plan.environment,
    mode: plan.mode,
    intentChaining: plan.intentChaining,
    rootInputs: plan.rootInputs,
    planSlug: plan.slug,
    revision: row.revision,
    definitionDigest: row.definition_digest,
    source: row.source,
    agentDeclarations: JSON.parse(row.declarations_json) as PlanRevision["agentDeclarations"],
    roleValues: JSON.parse(row.role_values_json) as PlanRevision["roleValues"],
    checkValues: JSON.parse(row.check_values_json) as PlanRevision["checkValues"],
    checks: checkJson.map((value) => JSON.parse(value) as PlanCheck),
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
