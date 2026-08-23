import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS environments (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS environment_variables (
    environment TEXT NOT NULL REFERENCES environments(name) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (environment, name)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS environment_credentials (
    environment TEXT NOT NULL REFERENCES environments(name) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (environment, name)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS published_procedures (
    procedure_name TEXT NOT NULL,
    procedure_version TEXT NOT NULL,
    definition_digest TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source TEXT NOT NULL,
    compiled_procedure_json TEXT NOT NULL,
    published_by TEXT NOT NULL,
    published_at TEXT NOT NULL,
    PRIMARY KEY (procedure_name, procedure_version),
    UNIQUE (definition_digest)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS published_procedures_cannot_change
  BEFORE UPDATE ON published_procedures
  BEGIN
    SELECT RAISE(ABORT, 'published procedures are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS published_procedures_cannot_be_deleted
  BEFORE DELETE ON published_procedures
  BEGIN
    SELECT RAISE(ABORT, 'published procedures are immutable');
  END;

  CREATE TABLE IF NOT EXISTS plans (
    plan_slug TEXT PRIMARY KEY,
    procedure_name TEXT NOT NULL,
    procedure_version TEXT NOT NULL,
    environment TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('live', 'dry-run')),
    intent_chaining INTEGER NOT NULL CHECK (intent_chaining IN (0, 1)),
    intent_chain_state TEXT NOT NULL CHECK (intent_chain_state IN ('DISABLED', 'NOT_STARTED', 'ACTIVE', 'COMPLETE')),
    current_intent TEXT,
    current_intent_check_uri TEXT,
    current_intent_attempt_key TEXT,
    root_inputs_json TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
    created_at TEXT NOT NULL,
    CHECK (
      (intent_chaining = 0 AND intent_chain_state = 'DISABLED' AND current_intent IS NULL AND current_intent_check_uri IS NULL AND current_intent_attempt_key IS NULL)
      OR (intent_chaining = 1 AND intent_chain_state = 'NOT_STARTED' AND current_intent IS NULL AND current_intent_check_uri IS NULL AND current_intent_attempt_key IS NULL)
      OR (intent_chaining = 1 AND intent_chain_state = 'ACTIVE' AND current_intent IS NOT NULL AND ((current_intent_check_uri IS NULL AND current_intent_attempt_key IS NULL) OR (current_intent_check_uri IS NOT NULL AND current_intent_attempt_key IS NOT NULL)))
      OR (intent_chaining = 1 AND intent_chain_state = 'COMPLETE' AND current_intent IS NULL AND current_intent_check_uri IS NULL AND current_intent_attempt_key IS NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS plan_revisions (
    id INTEGER PRIMARY KEY,
    plan_slug TEXT NOT NULL REFERENCES plans(plan_slug) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    definition_digest TEXT NOT NULL,
    source TEXT NOT NULL,
    declarations_json TEXT NOT NULL,
    role_values_json TEXT NOT NULL,
    check_values_json TEXT NOT NULL,
    compiled_at TEXT NOT NULL,
    UNIQUE (plan_slug, revision)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS plan_revisions_cannot_change
  BEFORE UPDATE ON plan_revisions
  BEGIN
    SELECT RAISE(ABORT, 'Plan revisions are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS plan_revision_definition_is_immutable
  BEFORE INSERT ON plan_revisions
  WHEN EXISTS (
    SELECT 1
      FROM plan_revisions existing_revision
      JOIN plans existing_plan ON existing_plan.plan_slug = existing_revision.plan_slug
      JOIN plans incoming_plan ON incoming_plan.plan_slug = NEW.plan_slug
     WHERE existing_plan.procedure_name = incoming_plan.procedure_name
       AND existing_plan.procedure_version = incoming_plan.procedure_version
       AND existing_revision.definition_digest <> NEW.definition_digest
  )
  BEGIN
    SELECT RAISE(ABORT, 'procedure version already has another definition digest');
  END;

  CREATE TABLE IF NOT EXISTS compiled_checks (
    plan_slug TEXT NOT NULL,
    plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
    check_uri TEXT NOT NULL,
    compiled_digest TEXT NOT NULL,
    check_json TEXT NOT NULL,
    PRIMARY KEY (plan_slug, plan_revision, check_uri),
    UNIQUE (plan_slug, plan_revision, check_uri, compiled_digest),
    FOREIGN KEY (plan_slug, plan_revision)
      REFERENCES plan_revisions(plan_slug, revision) ON DELETE CASCADE
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS compiled_checks_cannot_change
  BEFORE UPDATE ON compiled_checks
  BEGIN
    SELECT RAISE(ABORT, 'compiled Checks are immutable');
  END;

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    plan_slug TEXT NOT NULL REFERENCES plans(plan_slug) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'expired')),
    opened_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE (session_id, plan_slug)
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_plan
    ON sessions(plan_slug)
    WHERE state = 'open';

  CREATE TABLE IF NOT EXISTS attempts (
    attempt_handle TEXT PRIMARY KEY,
    attempt_key TEXT NOT NULL UNIQUE,
    execution_id TEXT NOT NULL UNIQUE,
    plan_slug TEXT NOT NULL,
    plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
    check_uri TEXT NOT NULL,
    compiled_digest TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    operation TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    action_input_json TEXT NOT NULL,

    environment TEXT NOT NULL,
    reobserve INTEGER NOT NULL CHECK (reobserve IN (0, 1)),
    intent TEXT,
    next_intent TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'interrupted', 'finalized')),
    admitted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    interrupted_at TEXT,
    finalized_at TEXT,
    finalization_json TEXT,
    UNIQUE (
      attempt_handle,
      plan_slug,
      plan_revision,
      check_uri,
      compiled_digest
    ),
    FOREIGN KEY (session_id, plan_slug)
      REFERENCES sessions(session_id, plan_slug),
    FOREIGN KEY (plan_slug, plan_revision, check_uri, compiled_digest)
      REFERENCES compiled_checks(plan_slug, plan_revision, check_uri, compiled_digest)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS facts (
    fact_id TEXT PRIMARY KEY,
    check_uri TEXT NOT NULL,
    compiled_digest TEXT NOT NULL,
    fact_index INTEGER NOT NULL CHECK (fact_index >= 0),
    operation TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS attempt_fact_receipts (
    attempt_handle TEXT NOT NULL REFERENCES attempts(attempt_handle) ON DELETE CASCADE,
    fact_id TEXT NOT NULL REFERENCES facts(fact_id),
    fact_index INTEGER NOT NULL CHECK (fact_index >= 0),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (attempt_handle, fact_index),
    UNIQUE (attempt_handle, fact_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS check_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    attempt_handle TEXT NOT NULL,
    plan_slug TEXT NOT NULL REFERENCES plans(plan_slug),
    plan_revision INTEGER NOT NULL,
    check_uri TEXT NOT NULL,
    compiled_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'satisfied')),
    verdict TEXT NOT NULL CHECK (verdict IN ('VALIDATED', 'NOT_VALIDATED')),
    reason_code TEXT NOT NULL,
    reason TEXT NOT NULL,
    fact_ids_json TEXT NOT NULL,
    checklist_delta_json TEXT NOT NULL,
    calculated_at TEXT NOT NULL,
    UNIQUE (check_uri, compiled_digest, fact_ids_json),
    FOREIGN KEY (
      attempt_handle,
      plan_slug,
      plan_revision,
      check_uri,
      compiled_digest
    ) REFERENCES attempts(
      attempt_handle,
      plan_slug,
      plan_revision,
      check_uri,
      compiled_digest
    ),
    FOREIGN KEY (plan_slug, plan_revision, check_uri, compiled_digest)
      REFERENCES compiled_checks(plan_slug, plan_revision, check_uri, compiled_digest)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS active_check_qualifications (
    plan_slug TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    check_uri TEXT NOT NULL,
    compiled_digest TEXT NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES check_snapshots(snapshot_id),
    activation_digest TEXT NOT NULL,
    PRIMARY KEY (plan_slug, plan_revision, check_uri),
    FOREIGN KEY (plan_slug, plan_revision, check_uri, compiled_digest)
      REFERENCES compiled_checks(plan_slug, plan_revision, check_uri, compiled_digest)
  ) STRICT;
`;

export const SQLITE_SCHEMA_DIGEST = createHash("sha256").update(SQLITE_SCHEMA).digest("hex");

const SCHEMA_METADATA = `
  CREATE TABLE trust_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    digest TEXT NOT NULL
  ) STRICT;
`;

export class IncompatibleSqliteSchemaError extends Error {
  readonly actualDigest: string | undefined;

  constructor(actualDigest: string | undefined) {
    super(
      "SQLite database schema is incompatible with this TRUST runtime. "
      + "Run 'node environments/trust-test/scripts/server.ts reset' to replace and reseed the local database.",
    );
    this.name = "IncompatibleSqliteSchemaError";
    this.actualDigest = actualDigest;
  }
}

export function initializeSqliteSchema(sqlite: DatabaseSync): void {
  const state = sqliteSchemaState(sqlite);
  if (state.kind === "incompatible") throw new IncompatibleSqliteSchemaError(state.digest);
  if (state.kind === "current") {
    sqlite.exec(SQLITE_SCHEMA);
    return;
  }
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(SQLITE_SCHEMA);
    sqlite.exec(SCHEMA_METADATA);
    sqlite.prepare("INSERT INTO trust_schema (singleton, digest) VALUES (1, ?)").run(SQLITE_SCHEMA_DIGEST);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

/** Server-manager preflight: an old local database is rejected before a tmux runtime is started. */
export function assertSqliteSchemaFile(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const sqlite = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
  try {
    const state = sqliteSchemaState(sqlite);
    if (state.kind === "incompatible") throw new IncompatibleSqliteSchemaError(state.digest);
  } finally {
    sqlite.close();
  }
}

type SqliteSchemaState =
  | { readonly kind: "empty" }
  | { readonly kind: "current" }
  | { readonly kind: "incompatible"; readonly digest?: string };

function sqliteSchemaState(sqlite: DatabaseSync): SqliteSchemaState {
  const tables = sqlite.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  if (tables.length === 0) return { kind: "empty" };
  if (!tables.some(({ name }) => name === "trust_schema")) return { kind: "incompatible" };
  const row = sqlite.prepare("SELECT digest FROM trust_schema WHERE singleton = 1").get() as { digest?: unknown } | undefined;
  const digest = typeof row?.digest === "string" ? row.digest : undefined;
  if (digest === SQLITE_SCHEMA_DIGEST) return { kind: "current" };
  return digest === undefined ? { kind: "incompatible" } : { kind: "incompatible", digest };
}
