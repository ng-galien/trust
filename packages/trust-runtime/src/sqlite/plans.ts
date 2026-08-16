import type {
  PlanCheck,
  PlanRevision,
  Plan,
} from "../model.js";
import type { DatabaseDriver, DatabaseRow } from "./database.js";

interface PlanRow extends DatabaseRow {
  plan_slug: string;
  procedure_name: string;
  procedure_version: string;
  environment: string;
  root_inputs_json: string;
  current_revision: number;
  created_at: string;
}

interface RevisionRow extends DatabaseRow {
  id: number;
  definition_digest: string;
  source: string;
  declarations_json: string;
  role_values_json: string;
  check_values_json: string;
}

interface RevisionNumberRow extends DatabaseRow {
  revision: number;
}

interface CheckRow extends DatabaseRow {
  check_json: string;
}

export interface PlanStoreDependencies {
  databaseDriver: DatabaseDriver;
}

export class PlanStore {
  readonly #database: DatabaseDriver;

  constructor({ databaseDriver }: PlanStoreDependencies) {
    this.#database = databaseDriver;
  }

  saveRevision(compiled: PlanRevision, compiledAt: string): void {
    this.#database.transaction(() => {
      const existing = this.findPlan(compiled.planSlug);
      if (
        existing &&
        (existing.procedure !== compiled.procedure ||
          existing.procedureVersion !== compiled.procedureVersion ||
          existing.environment !== compiled.environment ||
          canonicalJson(existing.rootInputs) !== canonicalJson(compiled.rootInputs))
      ) {
        throw new Error("a Plan cannot change its identity, environment or root inputs");
      }

      for (const check of compiled.checks) {
        if (check.planSlug !== compiled.planSlug || check.planRevision !== compiled.revision) {
          throw new Error("a Check must belong to its exact Plan revision");
        }
      }

      if (!existing) {
        if (compiled.revision !== 1) {
          throw new Error("a Plan must start at revision 1");
        }
        this.#database
          .prepare(
            `INSERT INTO plans (
               plan_slug, procedure_name, procedure_version, environment, root_inputs_json,
               current_revision, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            compiled.planSlug,
            compiled.procedure,
            compiled.procedureVersion,
            compiled.environment,
            JSON.stringify(compiled.rootInputs),
            compiled.revision,
            compiledAt,
          );
      } else if (compiled.revision !== existing.currentRevision + 1) {
        throw new Error("a Plan revision must advance monotonically by one");
      }

      const revision = this.#database
        .prepare(
          `INSERT INTO plan_revisions (
             plan_slug, revision, definition_digest, source, declarations_json,
             role_values_json, check_values_json, compiled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          compiled.planSlug,
          compiled.revision,
          compiled.definitionDigest,
          compiled.source,
          JSON.stringify(compiled.agentDeclarations),
          JSON.stringify(compiled.roleValues),
          JSON.stringify(compiled.checkValues),
          compiledAt,
        );
      void revision;

      const insertCheck = this.#database.prepare(
        `INSERT INTO compiled_checks (
           plan_slug, plan_revision, check_uri, compiled_digest, check_json
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const check of compiled.checks) {
        insertCheck.run(
          compiled.planSlug,
          compiled.revision,
          check.uri,
          check.compiledCheckDigest,
          JSON.stringify(check),
        );
      }

      if (existing) {
        const advanced = this.#database
          .prepare(
            `UPDATE plans
                SET current_revision = ?
              WHERE plan_slug = ? AND current_revision = ?`,
          )
          .run(compiled.revision, compiled.planSlug, existing.currentRevision);
        if (Number(advanced.changes) !== 1) {
          throw new Error("the current Plan revision changed while it was being advanced");
        }
      }
    });
  }

  findPlan(planSlug: string): Plan | undefined {
    const row = this.#database
      .prepare(
        `SELECT plan_slug, procedure_name, procedure_version, environment, root_inputs_json,
                current_revision, created_at
           FROM plans
          WHERE plan_slug = ?`,
      )
      .get<PlanRow>(planSlug);
    if (!row) {
      return undefined;
    }
    return toPlan(row);
  }

  listPlans(): Plan[] {
    return this.#database
      .prepare(
        `SELECT plan_slug, procedure_name, procedure_version, environment, root_inputs_json,
                current_revision, created_at
           FROM plans
          ORDER BY created_at DESC, plan_slug`,
      )
      .all<PlanRow>()
      .map(toPlan);
  }

  listRevisions(planSlug: string): PlanRevision[] {
    return this.#database
      .prepare(
        `SELECT revision
           FROM plan_revisions
          WHERE plan_slug = ?
          ORDER BY revision DESC`,
      )
      .all<RevisionNumberRow>(planSlug)
      .flatMap(({ revision }) => {
        const value = this.readRevision(planSlug, revision);
        return value === undefined ? [] : [value];
      });
  }

  findCurrentCheck(checkUri: string): PlanCheck | undefined {
    const row = this.#database
      .prepare(
        `SELECT compiled_checks.check_json
           FROM compiled_checks
           JOIN plans ON plans.plan_slug = compiled_checks.plan_slug
          WHERE compiled_checks.check_uri = ?
            AND compiled_checks.plan_revision = plans.current_revision`,
      )
      .get<CheckRow>(checkUri);
    return row ? (JSON.parse(row.check_json) as PlanCheck) : undefined;
  }

  listCurrentChecks(planSlug: string): PlanCheck[] {
    return this.#database
      .prepare(
        `SELECT compiled_checks.check_json
           FROM compiled_checks
           JOIN plans ON plans.plan_slug = compiled_checks.plan_slug
          WHERE plans.plan_slug = ?
            AND compiled_checks.plan_revision = plans.current_revision
          ORDER BY compiled_checks.check_uri`,
      )
      .all<CheckRow>(planSlug)
      .map((row) => JSON.parse(row.check_json) as PlanCheck);
  }

  findCheckAtRevision(
    planSlug: string,
    revision: number,
    checkUri: string,
  ): PlanCheck | undefined {
    const row = this.#database
      .prepare(
        `SELECT check_json
           FROM compiled_checks
          WHERE plan_slug = ? AND plan_revision = ? AND check_uri = ?`,
      )
      .get<CheckRow>(planSlug, revision, checkUri);
    return row ? (JSON.parse(row.check_json) as PlanCheck) : undefined;
  }

  readRevision(
    planSlug: string,
    revision: number,
  ): PlanRevision | undefined {
    const plan = this.findPlan(planSlug);
    if (!plan) return undefined;
    const row = this.#database
      .prepare(
        `SELECT id, definition_digest, source, declarations_json,
                role_values_json, check_values_json
           FROM plan_revisions
          WHERE plan_slug = ? AND revision = ?`,
      )
      .get<RevisionRow>(planSlug, revision);
    if (!row) return undefined;
    const checks = this.#database
      .prepare(
        `SELECT check_json
           FROM compiled_checks
          WHERE plan_slug = ? AND plan_revision = ?
          ORDER BY check_uri`,
      )
      .all<CheckRow>(planSlug, revision)
      .map((check) => JSON.parse(check.check_json) as PlanCheck);
    return {
      procedure: plan.procedure,
      procedureVersion: plan.procedureVersion,
      environment: plan.environment,
      rootInputs: plan.rootInputs,
      planSlug,
      revision,
      definitionDigest: row.definition_digest,
      source: row.source,
      agentDeclarations: JSON.parse(row.declarations_json) as PlanRevision["agentDeclarations"],
      roleValues: JSON.parse(row.role_values_json) as PlanRevision["roleValues"],
      checkValues: JSON.parse(row.check_values_json) as PlanRevision["checkValues"],
      checks,
    };
  }
}

function toPlan(row: PlanRow): Plan {
  return {
    slug: row.plan_slug,
    procedure: row.procedure_name,
    procedureVersion: row.procedure_version,
    environment: row.environment,
    rootInputs: JSON.parse(row.root_inputs_json) as Record<string, unknown>,
    currentRevision: row.current_revision,
    createdAt: row.created_at,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
