import { createHash } from "node:crypto";

/** One PostgreSQL schema for the embedded and server adapters. */
export const POSTGRES_SCHEMA_VERSION = 5;
export const POSTGRES_SCHEMA = `
  CREATE TABLE source_templates (
    id TEXT COLLATE "C" PRIMARY KEY,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    title TEXT COLLATE "C" NOT NULL,
    description TEXT COLLATE "C" NOT NULL,
    body TEXT COLLATE "C" NOT NULL,
    parameters_json JSONB NOT NULL CHECK (jsonb_typeof(parameters_json) IN ('array')),
    revision BIGINT NOT NULL CHECK (revision >= 1) CHECK (revision BETWEEN -9007199254740991 AND 9007199254740991)
  );

  CREATE TABLE registry_sources (
    name TEXT COLLATE "C" PRIMARY KEY,
    kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('git', 'http', 'file')),
    url TEXT COLLATE "C" NOT NULL,
    reference TEXT COLLATE "C",
    created_at TIMESTAMPTZ(3) NOT NULL,
    updated_at TIMESTAMPTZ(3) NOT NULL,
    CHECK ((kind = 'git') OR (reference IS NULL))
  );

  CREATE TABLE registry_source_indexes (
    source_name TEXT COLLATE "C" PRIMARY KEY REFERENCES registry_sources(name) ON DELETE CASCADE,
    revision TEXT COLLATE "C" NOT NULL,
    index_json JSONB NOT NULL CHECK (jsonb_typeof(index_json) IN ('object')),
    refreshed_at TIMESTAMPTZ(3) NOT NULL
  );

  CREATE TABLE registry_packages (
    package_name TEXT COLLATE "C" PRIMARY KEY,
    version TEXT COLLATE "C" NOT NULL,
    source_name TEXT COLLATE "C" NOT NULL,
    revision TEXT COLLATE "C" NOT NULL,
    directory TEXT COLLATE "C" NOT NULL,
    declaration_json JSONB NOT NULL CHECK (jsonb_typeof(declaration_json) IN ('object')),
    installed_at TIMESTAMPTZ(3) NOT NULL,
    updated_at TIMESTAMPTZ(3) NOT NULL
  );

  CREATE TABLE extension_installations (
    installation_id TEXT COLLATE "C" PRIMARY KEY,
    manifest TEXT COLLATE "C" NOT NULL,
    environment TEXT COLLATE "C" NOT NULL,
    grants_json JSONB NOT NULL CHECK (jsonb_typeof(grants_json) IN ('array')),
    credential_environment_json JSONB NOT NULL CHECK (jsonb_typeof(credential_environment_json) IN ('array')),
    auto_start BOOLEAN NOT NULL,
    installed_at TIMESTAMPTZ(3) NOT NULL,
    updated_at TIMESTAMPTZ(3) NOT NULL
  );

  CREATE TABLE extension_settings (
    installation_id TEXT COLLATE "C" PRIMARY KEY,
    settings_json JSONB NOT NULL CHECK (jsonb_typeof(settings_json) IN ('object')),
    revision BIGINT NOT NULL CHECK (revision >= 1) CHECK (revision BETWEEN -9007199254740991 AND 9007199254740991),
    updated_at TIMESTAMPTZ(3) NOT NULL
  );

  CREATE TABLE environments (
    name TEXT COLLATE "C" PRIMARY KEY,
    created_at TIMESTAMPTZ(3) NOT NULL,
    updated_at TIMESTAMPTZ(3) NOT NULL
  );

  CREATE TABLE environment_variables (
    environment TEXT COLLATE "C" NOT NULL REFERENCES environments(name) ON DELETE CASCADE,
    name TEXT COLLATE "C" NOT NULL,
    value TEXT COLLATE "C" NOT NULL,
    updated_at TIMESTAMPTZ(3) NOT NULL,
    PRIMARY KEY (environment, name)
  );

  CREATE TABLE environment_credentials (
    environment TEXT COLLATE "C" NOT NULL REFERENCES environments(name) ON DELETE CASCADE,
    name TEXT COLLATE "C" NOT NULL,
    value TEXT COLLATE "C" NOT NULL,
    updated_at TIMESTAMPTZ(3) NOT NULL,
    PRIMARY KEY (environment, name)
  );

  CREATE TABLE published_procedures (
    procedure_name TEXT COLLATE "C" NOT NULL,
    procedure_version TEXT COLLATE "C" NOT NULL,
    definition_digest TEXT COLLATE "C" NOT NULL,
    source_name TEXT COLLATE "C" NOT NULL,
    source TEXT COLLATE "C" NOT NULL,
    compiled_procedure_json JSONB NOT NULL CHECK (jsonb_typeof(compiled_procedure_json) IN ('object')),
    published_by TEXT COLLATE "C" NOT NULL,
    published_at TIMESTAMPTZ(3) NOT NULL,
    PRIMARY KEY (procedure_name, procedure_version),
    UNIQUE (definition_digest)
  );

  CREATE TABLE published_vocabularies (
    vocabulary_name TEXT COLLATE "C" NOT NULL,
    vocabulary_version TEXT COLLATE "C" NOT NULL,
    definition_digest TEXT COLLATE "C" NOT NULL,
    source_name TEXT COLLATE "C" NOT NULL,
    source TEXT COLLATE "C" NOT NULL,
    compiled_vocabulary_json JSONB NOT NULL CHECK (jsonb_typeof(compiled_vocabulary_json) IN ('object')),
    published_by TEXT COLLATE "C" NOT NULL,
    published_at TIMESTAMPTZ(3) NOT NULL,
    PRIMARY KEY (vocabulary_name, vocabulary_version)
  );

  CREATE TABLE catalog_metadata_revisions (
    kind TEXT COLLATE "C" NOT NULL CHECK (kind IN ('operation', 'procedure')),
    name TEXT COLLATE "C" NOT NULL,
    version TEXT COLLATE "C" NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1) CHECK (revision BETWEEN -9007199254740991 AND 9007199254740991),
    title TEXT COLLATE "C" NOT NULL,
    description TEXT COLLATE "C",
    classification_json JSONB NOT NULL CHECK (jsonb_typeof(classification_json) IN ('object')),
    updated_at TIMESTAMPTZ(3) NOT NULL,
    PRIMARY KEY (kind, name, version, revision)
  );



  CREATE TABLE plans (
    creator_issuer TEXT COLLATE "C",
    creator_subject TEXT COLLATE "C",
    CHECK ((creator_issuer IS NULL AND creator_subject IS NULL) OR (creator_issuer IS NOT NULL AND creator_subject IS NOT NULL AND length(creator_issuer) > 0 AND length(creator_subject) > 0)),
    plan_slug TEXT COLLATE "C" PRIMARY KEY,
    procedure_name TEXT COLLATE "C" NOT NULL,
    procedure_version TEXT COLLATE "C" NOT NULL,
    environment TEXT COLLATE "C" NOT NULL,
    mode TEXT COLLATE "C" NOT NULL CHECK (mode IN ('live', 'dry-run')),
    intent_chaining BOOLEAN NOT NULL,
    intent_chain_state TEXT COLLATE "C" NOT NULL CHECK (intent_chain_state IN ('DISABLED', 'NOT_STARTED', 'ACTIVE', 'COMPLETE')),
    current_intent TEXT COLLATE "C",
    current_intent_check_uri TEXT COLLATE "C",
    current_intent_attempt_key TEXT COLLATE "C",
    metadata_json JSONB NOT NULL CHECK (jsonb_typeof(metadata_json) IN ('object')),
    root_inputs_json JSONB NOT NULL CHECK (jsonb_typeof(root_inputs_json) IN ('object')),
    current_revision BIGINT NOT NULL CHECK (current_revision >= 1) CHECK (current_revision BETWEEN -9007199254740991 AND 9007199254740991),
    created_at TIMESTAMPTZ(3) NOT NULL,
    CHECK (
      (intent_chaining = FALSE AND intent_chain_state = 'DISABLED' AND current_intent IS NULL AND current_intent_check_uri IS NULL AND current_intent_attempt_key IS NULL)
      OR (intent_chaining = TRUE AND intent_chain_state = 'NOT_STARTED' AND current_intent IS NULL AND current_intent_check_uri IS NULL AND current_intent_attempt_key IS NULL)
      OR (intent_chaining = TRUE AND intent_chain_state = 'ACTIVE' AND current_intent IS NOT NULL AND ((current_intent_check_uri IS NULL AND current_intent_attempt_key IS NULL) OR (current_intent_check_uri IS NOT NULL AND current_intent_attempt_key IS NOT NULL)))
      OR (intent_chaining = TRUE AND intent_chain_state = 'COMPLETE' AND current_intent IS NULL AND current_intent_check_uri IS NULL AND current_intent_attempt_key IS NULL)
    )
  );

  CREATE TABLE plan_revisions (
    resolved_procedure_json JSONB NOT NULL CHECK (jsonb_typeof(resolved_procedure_json) IN ('object')),
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY CHECK (id BETWEEN -9007199254740991 AND 9007199254740991),
    plan_slug TEXT COLLATE "C" NOT NULL REFERENCES plans(plan_slug) ON DELETE CASCADE,
    revision BIGINT NOT NULL CHECK (revision >= 1) CHECK (revision BETWEEN -9007199254740991 AND 9007199254740991),
    definition_digest TEXT COLLATE "C" NOT NULL,
    source TEXT COLLATE "C" NOT NULL,
    declarations_json JSONB NOT NULL CHECK (jsonb_typeof(declarations_json) IN ('object')),
    mission_declarations_json JSONB NOT NULL CHECK (jsonb_typeof(mission_declarations_json) IN ('object')),
    resolved_missions_json JSONB NOT NULL CHECK (jsonb_typeof(resolved_missions_json) IN ('object')),
    role_values_json JSONB NOT NULL CHECK (jsonb_typeof(role_values_json) IN ('array','object')),
    check_values_json JSONB NOT NULL CHECK (jsonb_typeof(check_values_json) IN ('array')),
    invocations_json JSONB NOT NULL CHECK (jsonb_typeof(invocations_json) IN ('array')),
    compiled_at TIMESTAMPTZ(3) NOT NULL,
    UNIQUE (plan_slug, revision)
  );

  CREATE TABLE child_generations (
    parent_plan TEXT COLLATE "C" NOT NULL REFERENCES plans(plan_slug),
    invocation_id TEXT COLLATE "C" NOT NULL,
    generation BIGINT NOT NULL CHECK (generation >= 1) CHECK (generation BETWEEN -9007199254740991 AND 9007199254740991),
    child_plan TEXT COLLATE "C" NOT NULL UNIQUE REFERENCES plans(plan_slug),
    input_digest TEXT COLLATE "C" NOT NULL,
    comparison_fingerprint TEXT COLLATE "C",
    observed_revision BIGINT NOT NULL CHECK (observed_revision BETWEEN -9007199254740991 AND 9007199254740991),
    created_at TIMESTAMPTZ(3) NOT NULL,
    superseded_at TIMESTAMPTZ(3),
    CHECK (superseded_at IS NOT NULL OR comparison_fingerprint IS NOT NULL),
    PRIMARY KEY(parent_plan, invocation_id, generation)
  );
  CREATE UNIQUE INDEX child_generation_current
    ON child_generations(parent_plan, invocation_id) WHERE superseded_at IS NULL;



  CREATE TABLE compiled_checks (
    plan_slug TEXT COLLATE "C" NOT NULL,
    plan_revision BIGINT NOT NULL CHECK (plan_revision >= 1) CHECK (plan_revision BETWEEN -9007199254740991 AND 9007199254740991),
    check_uri TEXT COLLATE "C" NOT NULL,
    compiled_digest TEXT COLLATE "C" NOT NULL,
    check_json JSONB NOT NULL CHECK (jsonb_typeof(check_json) IN ('object')),
    PRIMARY KEY (plan_slug, plan_revision, check_uri),
    UNIQUE (plan_slug, plan_revision, check_uri, compiled_digest),
    FOREIGN KEY (plan_slug, plan_revision)
      REFERENCES plan_revisions(plan_slug, revision) ON DELETE CASCADE
  );


  CREATE TABLE sessions (
    session_id UUID PRIMARY KEY,
    plan_slug TEXT COLLATE "C" NOT NULL REFERENCES plans(plan_slug) ON DELETE CASCADE,
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('open', 'closed', 'expired')),
    opened_at TIMESTAMPTZ(3) NOT NULL,
    expires_at TIMESTAMPTZ(3) NOT NULL,
    closed_at TIMESTAMPTZ(3),
    UNIQUE (session_id, plan_slug)
  );

  CREATE UNIQUE INDEX one_open_session_per_plan
    ON sessions(plan_slug)
    WHERE state = 'open';

  CREATE TABLE attempts (
    actor_issuer TEXT COLLATE "C",
    actor_subject TEXT COLLATE "C",
    CHECK ((actor_issuer IS NULL AND actor_subject IS NULL) OR (actor_issuer IS NOT NULL AND actor_subject IS NOT NULL AND length(actor_issuer) > 0 AND length(actor_subject) > 0)),
    invocation_digest TEXT COLLATE "C",
    attempt_order BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY CHECK (attempt_order BETWEEN -9007199254740991 AND 9007199254740991),
    attempt_handle UUID NOT NULL UNIQUE,
    attempt_key TEXT COLLATE "C" NOT NULL UNIQUE,
    execution_id UUID NOT NULL UNIQUE,
    plan_slug TEXT COLLATE "C" NOT NULL,
    plan_revision BIGINT NOT NULL CHECK (plan_revision >= 1) CHECK (plan_revision BETWEEN -9007199254740991 AND 9007199254740991),
    check_uri TEXT COLLATE "C" NOT NULL,
    compiled_digest TEXT COLLATE "C" NOT NULL,
    session_id UUID NOT NULL REFERENCES sessions(session_id),
    operation TEXT COLLATE "C" NOT NULL,
    operation_digest TEXT COLLATE "C" NOT NULL,
    action_input_json JSONB NOT NULL CHECK (jsonb_typeof(action_input_json) IN ('object')),

    environment TEXT COLLATE "C" NOT NULL,
    reobserve BOOLEAN NOT NULL,
    intent TEXT COLLATE "C",
    next_intent TEXT COLLATE "C",
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('pending', 'interrupted', 'finalized')),
    admitted_at TIMESTAMPTZ(3) NOT NULL,
    expires_at TIMESTAMPTZ(3) NOT NULL,
    interrupted_at TIMESTAMPTZ(3),
    finalized_at TIMESTAMPTZ(3),
    finalization_json JSONB CHECK (jsonb_typeof(finalization_json) IN ('object')),
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
  );

  CREATE TABLE facts (
    fact_id TEXT COLLATE "C" PRIMARY KEY,
    check_uri TEXT COLLATE "C" NOT NULL,
    compiled_digest TEXT COLLATE "C" NOT NULL,
    fact_index BIGINT NOT NULL CHECK (fact_index >= 0) CHECK (fact_index BETWEEN -9007199254740991 AND 9007199254740991),
    operation TEXT COLLATE "C" NOT NULL,
    operation_digest TEXT COLLATE "C" NOT NULL,
    observed_at TEXT COLLATE "C" NOT NULL,
    payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json) IN ('object'))
  );

  CREATE TABLE attempt_fact_receipts (
    attempt_handle UUID NOT NULL REFERENCES attempts(attempt_handle) ON DELETE CASCADE,
    fact_id TEXT COLLATE "C" NOT NULL REFERENCES facts(fact_id),
    fact_index BIGINT NOT NULL CHECK (fact_index >= 0) CHECK (fact_index BETWEEN -9007199254740991 AND 9007199254740991),
    recorded_at TEXT COLLATE "C" NOT NULL,
    PRIMARY KEY (attempt_handle, fact_index),
    UNIQUE (attempt_handle, fact_id)
  );

  CREATE TABLE check_snapshots (
    snapshot_id TEXT COLLATE "C" PRIMARY KEY,
    attempt_handle UUID NOT NULL,
    plan_slug TEXT COLLATE "C" NOT NULL REFERENCES plans(plan_slug),
    plan_revision BIGINT NOT NULL CHECK (plan_revision BETWEEN -9007199254740991 AND 9007199254740991),
    check_uri TEXT COLLATE "C" NOT NULL,
    compiled_digest TEXT COLLATE "C" NOT NULL,
    state TEXT COLLATE "C" NOT NULL CHECK (state IN ('open', 'satisfied')),
    verdict TEXT COLLATE "C" NOT NULL CHECK (verdict IN ('VALIDATED', 'NOT_VALIDATED')),
    CHECK ((state = 'satisfied' AND verdict = 'VALIDATED') OR (state = 'open' AND verdict = 'NOT_VALIDATED')),
    reason_code TEXT COLLATE "C" NOT NULL,
    reason TEXT COLLATE "C" NOT NULL,
    fact_ids_json JSONB NOT NULL CHECK (jsonb_typeof(fact_ids_json) IN ('array')),
    checklist_delta_json JSONB NOT NULL CHECK (jsonb_typeof(checklist_delta_json) IN ('object')),
    calculated_at TIMESTAMPTZ(3) NOT NULL,
    equivalence_digest TEXT COLLATE "C" NOT NULL UNIQUE CHECK (equivalence_digest ~ '^[0-9a-f]{64}$'),
    UNIQUE (snapshot_id, plan_slug, check_uri, compiled_digest),
    UNIQUE (snapshot_id, plan_slug, plan_revision, check_uri, compiled_digest),
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
  );

  CREATE TABLE active_check_qualifications (
    plan_slug TEXT COLLATE "C" NOT NULL,
    plan_revision BIGINT NOT NULL CHECK (plan_revision BETWEEN -9007199254740991 AND 9007199254740991),
    check_uri TEXT COLLATE "C" NOT NULL,
    compiled_digest TEXT COLLATE "C" NOT NULL,
    snapshot_id TEXT COLLATE "C" NOT NULL REFERENCES check_snapshots(snapshot_id),
    activation_digest TEXT COLLATE "C" NOT NULL,
    FOREIGN KEY (snapshot_id, plan_slug, check_uri, compiled_digest)
      REFERENCES check_snapshots(snapshot_id, plan_slug, check_uri, compiled_digest),
    PRIMARY KEY (plan_slug, plan_revision, check_uri),
    FOREIGN KEY (plan_slug, plan_revision, check_uri, compiled_digest)
      REFERENCES compiled_checks(plan_slug, plan_revision, check_uri, compiled_digest)
  );

  CREATE TABLE plan_escalations (
    escalation_id UUID PRIMARY KEY,
    plan_slug TEXT COLLATE "C" NOT NULL REFERENCES plans(plan_slug) ON DELETE CASCADE,
    plan_revision BIGINT NOT NULL CHECK (plan_revision BETWEEN -9007199254740991 AND 9007199254740991),
    snapshot_plan_revision BIGINT NOT NULL CHECK (snapshot_plan_revision BETWEEN -9007199254740991 AND 9007199254740991),
    check_uri TEXT COLLATE "C" NOT NULL,
    compiled_digest TEXT COLLATE "C" NOT NULL,
    snapshot_id TEXT COLLATE "C" NOT NULL,
    attempt_handle UUID NOT NULL REFERENCES attempts(attempt_handle),
    blocking_reason TEXT COLLATE "C" NOT NULL,
    forbidden_further_action TEXT COLLATE "C" NOT NULL,
    escalated_at TIMESTAMPTZ(3) NOT NULL,
    resumed_at TIMESTAMPTZ(3),
    resume_reason TEXT COLLATE "C",
    CHECK ((resumed_at IS NULL AND resume_reason IS NULL) OR (resumed_at IS NOT NULL AND resume_reason IS NOT NULL)),
    FOREIGN KEY (snapshot_id, plan_slug, snapshot_plan_revision, check_uri, compiled_digest)
      REFERENCES check_snapshots(snapshot_id, plan_slug, plan_revision, check_uri, compiled_digest)
  );

  CREATE UNIQUE INDEX one_active_escalation_per_plan
    ON plan_escalations(plan_slug)
    WHERE resumed_at IS NULL;

  CREATE UNIQUE INDEX one_escalation_per_attempt
    ON plan_escalations(attempt_handle);

  CREATE TABLE plan_cancellations (
    plan_slug TEXT COLLATE "C" PRIMARY KEY REFERENCES plans(plan_slug) ON DELETE CASCADE,
    root_plan TEXT COLLATE "C" NOT NULL,
    cancelled_at TIMESTAMPTZ(3) NOT NULL,
    actor_issuer TEXT COLLATE "C",
    actor_subject TEXT COLLATE "C",
    CHECK ((actor_issuer IS NULL AND actor_subject IS NULL) OR (actor_issuer IS NOT NULL AND actor_subject IS NOT NULL AND length(actor_issuer) > 0 AND length(actor_subject) > 0)),
    reason TEXT COLLATE "C" NOT NULL CHECK (length(reason) BETWEEN 1 AND 4096)
  );



  CREATE FUNCTION trust_refuse_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '23514';
  END;
  $$;
  CREATE TRIGGER plan_creator_cannot_change BEFORE UPDATE OF creator_issuer, creator_subject ON plans
    FOR EACH ROW WHEN (OLD.creator_issuer IS DISTINCT FROM NEW.creator_issuer OR OLD.creator_subject IS DISTINCT FROM NEW.creator_subject)
    EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE TRIGGER attempt_actor_cannot_change BEFORE UPDATE OF actor_issuer, actor_subject ON attempts
    FOR EACH ROW WHEN (OLD.actor_issuer IS DISTINCT FROM NEW.actor_issuer OR OLD.actor_subject IS DISTINCT FROM NEW.actor_subject)
    EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE FUNCTION trust_require_child_creator() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM plans parent JOIN plans child ON child.plan_slug = NEW.child_plan
      WHERE parent.plan_slug = NEW.parent_plan AND
      (parent.creator_issuer IS DISTINCT FROM child.creator_issuer OR parent.creator_subject IS DISTINCT FROM child.creator_subject)) THEN
      RAISE EXCEPTION 'Child Plan must inherit its parent creator' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER child_creator_matches_parent BEFORE INSERT OR UPDATE OF parent_plan, child_plan ON child_generations
    FOR EACH ROW EXECUTE FUNCTION trust_require_child_creator();
  CREATE INDEX plans_creator_created ON plans(creator_issuer, creator_subject, created_at DESC, plan_slug ASC);
  CREATE TRIGGER published_procedures_cannot_change BEFORE UPDATE OR DELETE ON published_procedures
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE TRIGGER published_vocabularies_cannot_change BEFORE UPDATE OR DELETE ON published_vocabularies
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE TRIGGER plan_revisions_cannot_change BEFORE UPDATE ON plan_revisions
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE TRIGGER compiled_checks_cannot_change BEFORE UPDATE ON compiled_checks
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE TRIGGER facts_cannot_change BEFORE UPDATE OR DELETE ON facts
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE TRIGGER check_snapshots_cannot_change BEFORE UPDATE ON check_snapshots
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE TRIGGER attempt_fact_receipts_cannot_change BEFORE UPDATE ON attempt_fact_receipts
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE TRIGGER catalog_metadata_revisions_cannot_change BEFORE UPDATE OR DELETE ON catalog_metadata_revisions
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();
  CREATE TRIGGER plan_cancellations_cannot_change BEFORE UPDATE ON plan_cancellations
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();

  CREATE FUNCTION trust_require_pinned_composition() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM plan_revisions WHERE plan_slug = NEW.plan_slug
      AND (definition_digest <> NEW.definition_digest OR resolved_procedure_json <> NEW.resolved_procedure_json)) THEN
      RAISE EXCEPTION 'Plan composition is pinned at engagement' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER plan_revision_definition_is_immutable BEFORE INSERT ON plan_revisions
    FOR EACH ROW EXECUTE FUNCTION trust_require_pinned_composition();

  CREATE FUNCTION trust_require_active_plan() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM plan_escalations WHERE plan_slug = NEW.plan_slug AND resumed_at IS NULL) THEN
      RAISE EXCEPTION 'Plan is escalated' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM plan_cancellations WHERE plan_slug = NEW.plan_slug) THEN
      RAISE EXCEPTION 'Plan is cancelled' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER attempts_require_active_plan BEFORE INSERT ON attempts
    FOR EACH ROW EXECUTE FUNCTION trust_require_active_plan();
  CREATE TRIGGER plan_revisions_require_active_plan BEFORE INSERT ON plan_revisions
    FOR EACH ROW EXECUTE FUNCTION trust_require_active_plan();

  CREATE INDEX attempts_check_order ON attempts(check_uri, attempt_order DESC);
  CREATE INDEX attempts_pending_plan ON attempts(plan_slug, attempt_order DESC) WHERE state = 'pending';
  CREATE INDEX compiled_checks_uri_revision ON compiled_checks(check_uri, plan_revision);
  CREATE INDEX snapshots_check_time ON check_snapshots(check_uri, calculated_at DESC, snapshot_id DESC);
  CREATE INDEX snapshots_time ON check_snapshots(calculated_at DESC, snapshot_id DESC);
  CREATE INDEX snapshots_plan_time ON check_snapshots(plan_slug, calculated_at DESC, snapshot_id DESC);
  CREATE INDEX plans_created ON plans(created_at DESC, plan_slug ASC);
  CREATE INDEX sessions_plan_opened ON sessions(plan_slug, opened_at DESC);
`;
export const POSTGRES_SCHEMA_DIGEST = createHash("sha256").update(POSTGRES_SCHEMA).digest("hex");

/** Kept deliberately separate from the business tables and from SQLite import provenance. */
export const POSTGRES_SCHEMA_METADATA = `
  CREATE TABLE trust_schema (
    singleton SMALLINT PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    digest TEXT NOT NULL
  );
`;

export interface SchemaConnection {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  exec(sql: string): Promise<unknown>;
}

/** Prepare only an empty database; an unknown existing schema is never overwritten. */
export async function preparePostgresSchema(connection: SchemaConnection): Promise<void> {
  await connection.exec("SET search_path = public, pg_catalog; SET TIME ZONE 'UTC'");
  const tables = await connection.query(
    "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  if (tables.rows.length > 0) {
    if (!tables.rows.some((row) => row.tablename === "trust_schema")) {
      throw new Error("Existing database is not a prepared TRUST PostgreSQL database; no data was changed.");
    }
    const metadata = await connection.query("SELECT version, digest FROM trust_schema WHERE singleton = 1");
    if (
      metadata.rows.length !== 1 ||
      metadata.rows[0]?.version !== POSTGRES_SCHEMA_VERSION ||
      metadata.rows[0]?.digest !== POSTGRES_SCHEMA_DIGEST
    ) {
      throw new Error("TRUST PostgreSQL schema is incompatible; use an explicit verified data-preserving upgrade.");
    }
    return;
  }
  await connection.exec("BEGIN");
  try {
    await connection.exec(POSTGRES_SCHEMA);
    await connection.exec(POSTGRES_SCHEMA_METADATA);
    await connection.query("INSERT INTO trust_schema(singleton, version, digest) VALUES (1, $1, $2)", [
      POSTGRES_SCHEMA_VERSION,
      POSTGRES_SCHEMA_DIGEST,
    ]);
    await connection.exec("COMMIT");
  } catch (error) {
    await connection.exec("ROLLBACK");
    throw error;
  }
}
