import type { DatabaseDriver } from "../ports/database.js";

const CURRENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS published_procedures (
    procedure_name TEXT NOT NULL,
    procedure_version TEXT NOT NULL,
    definition_digest TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source TEXT NOT NULL,
    compiled_definition_json TEXT NOT NULL,
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

  CREATE TABLE IF NOT EXISTS published_definition_requirements (
    definition_digest TEXT NOT NULL REFERENCES published_procedures(definition_digest),
    capability TEXT NOT NULL,
    contract_core_digest TEXT NOT NULL,
    action_contract_digest TEXT NOT NULL,
    requirement_json TEXT NOT NULL,
    published_at TEXT NOT NULL,
    PRIMARY KEY (definition_digest, capability),
    UNIQUE (definition_digest, capability, action_contract_digest)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS published_requirement_exact_match
    ON published_definition_requirements(capability, action_contract_digest);

  CREATE TRIGGER IF NOT EXISTS published_definition_requirements_cannot_change
  BEFORE UPDATE ON published_definition_requirements
  BEGIN
    SELECT RAISE(ABORT, 'published capability requirements are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS published_definition_requirements_cannot_be_deleted
  BEFORE DELETE ON published_definition_requirements
  BEGIN
    SELECT RAISE(ABORT, 'published capability requirements are immutable');
  END;

  CREATE TABLE IF NOT EXISTS skill_release_claims (
    release_digest TEXT PRIMARY KEY,
    skill TEXT NOT NULL,
    version TEXT NOT NULL,
    publisher TEXT NOT NULL,
    claim_json TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    UNIQUE (skill, version)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS skill_release_claims_cannot_change
  BEFORE UPDATE ON skill_release_claims
  BEGIN
    SELECT RAISE(ABORT, 'Skill release claims are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS skill_release_claims_cannot_be_deleted
  BEFORE DELETE ON skill_release_claims
  BEGIN
    SELECT RAISE(ABORT, 'Skill release claims are immutable');
  END;

  CREATE TABLE IF NOT EXISTS skill_verified_distributions (
    distribution_digest TEXT PRIMARY KEY,
    release_digest TEXT NOT NULL REFERENCES skill_release_claims(release_digest),
    issuer TEXT NOT NULL,
    signature TEXT NOT NULL,
    verified_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS skill_verified_distributions_cannot_change
  BEFORE UPDATE ON skill_verified_distributions
  BEGIN
    SELECT RAISE(ABORT, 'verified distribution links are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS skill_verified_distributions_cannot_be_deleted
  BEFORE DELETE ON skill_verified_distributions
  BEGIN
    SELECT RAISE(ABORT, 'verified distribution links are immutable');
  END;

  CREATE TABLE IF NOT EXISTS skill_release_authorizations (
    environment TEXT NOT NULL,
    release_digest TEXT NOT NULL REFERENCES skill_release_claims(release_digest),
    authorized_by TEXT NOT NULL,
    authorized_at TEXT NOT NULL,
    PRIMARY KEY (environment, release_digest)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS skill_deployment_authorizations (
    environment TEXT NOT NULL,
    logical_deployment_key TEXT NOT NULL,
    release_digest TEXT NOT NULL REFERENCES skill_release_claims(release_digest),
    envelope TEXT NOT NULL CHECK (envelope IN ('cli', 'mcp-stdio', 'mcp-http')),
    runtime_identity TEXT NOT NULL,
    authorized_by TEXT NOT NULL,
    authorized_at TEXT NOT NULL,
    PRIMARY KEY (
      environment,
      logical_deployment_key,
      release_digest,
      envelope,
      runtime_identity
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS skill_deployment_selections (
    environment TEXT NOT NULL,
    capability TEXT NOT NULL,
    action_contract_digest TEXT NOT NULL,
    logical_deployment_key TEXT NOT NULL,
    selected_by TEXT NOT NULL,
    selected_at TEXT NOT NULL,
    PRIMARY KEY (
      environment, capability, action_contract_digest
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS skill_deployment_announcements (
    environment TEXT NOT NULL,
    logical_deployment_key TEXT NOT NULL,
    envelope TEXT NOT NULL CHECK (envelope IN ('cli', 'mcp-stdio', 'mcp-http')),
    runtime_identity TEXT NOT NULL,
    process_identity TEXT NOT NULL,
    release_digest TEXT NOT NULL REFERENCES skill_release_claims(release_digest),
    distribution_digest TEXT NOT NULL,
    probes_json TEXT NOT NULL,
    announced_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    PRIMARY KEY (environment, logical_deployment_key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS plans (
    plan_slug TEXT PRIMARY KEY,
    procedure_name TEXT NOT NULL,
    procedure_version TEXT NOT NULL,
    environment TEXT NOT NULL,
    root_inputs_json TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS plan_revisions (
    id INTEGER PRIMARY KEY,
    plan_slug TEXT NOT NULL REFERENCES plans(plan_slug) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    definition_digest TEXT NOT NULL,
    source TEXT NOT NULL,
    agent_declarations_json TEXT NOT NULL,
    agent_declaration_activations_json TEXT NOT NULL,
    role_incarnations_json TEXT NOT NULL,
    validated_outputs_json TEXT NOT NULL,
    validated_reports_json TEXT NOT NULL,
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

  CREATE TABLE IF NOT EXISTS executions (
    execution_handle TEXT PRIMARY KEY,
    attempt_key TEXT NOT NULL UNIQUE,
    plan_slug TEXT NOT NULL,
    plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
    check_uri TEXT NOT NULL,
    compiled_digest TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    capability TEXT NOT NULL,
    action_contract_digest TEXT NOT NULL,
    action_input_json TEXT NOT NULL,
    materialization_contract_json TEXT NOT NULL,
    release_digest TEXT NOT NULL,
    environment TEXT NOT NULL,
    deployment_key TEXT NOT NULL,
    envelope TEXT NOT NULL CHECK (envelope IN ('cli', 'mcp-stdio', 'mcp-http')),
    runtime_identity TEXT NOT NULL,
    process_identity TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'finalized')),
    granted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    finalized_at TEXT,
    UNIQUE (
      execution_handle,
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
    capability TEXT NOT NULL,
    action_contract_digest TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS execution_fact_receipts (
    execution_handle TEXT NOT NULL REFERENCES executions(execution_handle) ON DELETE CASCADE,
    fact_id TEXT NOT NULL REFERENCES facts(fact_id),
    fact_index INTEGER NOT NULL CHECK (fact_index >= 0),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (execution_handle, fact_index),
    UNIQUE (execution_handle, fact_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS check_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    execution_handle TEXT NOT NULL,
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
      execution_handle,
      plan_slug,
      plan_revision,
      check_uri,
      compiled_digest
    ) REFERENCES executions(
      execution_handle,
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

export function initializeCurrentSchema(databaseDriver: DatabaseDriver): void {
  databaseDriver.exec(CURRENT_SCHEMA);
}

export function recreateCurrentSchema(databaseDriver: DatabaseDriver): void {
  databaseDriver.exec(`
    DROP TABLE IF EXISTS active_check_qualifications;
    DROP TABLE IF EXISTS check_snapshots;
    DROP TABLE IF EXISTS execution_fact_receipts;
    DROP TABLE IF EXISTS facts;
    DROP TABLE IF EXISTS executions;
    DROP INDEX IF EXISTS one_open_session_per_plan;
    DROP TABLE IF EXISTS sessions;
    DROP TRIGGER IF EXISTS compiled_checks_cannot_change;
    DROP TABLE IF EXISTS compiled_checks;
    DROP TRIGGER IF EXISTS plan_revisions_cannot_change;
    DROP TRIGGER IF EXISTS plan_revision_definition_is_immutable;
    DROP TABLE IF EXISTS plan_revisions;
    DROP TABLE IF EXISTS plans;
    DROP TABLE IF EXISTS skill_deployment_announcements;
    DROP TABLE IF EXISTS skill_deployment_selections;
    DROP TABLE IF EXISTS skill_deployment_authorizations;
    DROP TABLE IF EXISTS skill_release_authorizations;
    DROP TABLE IF EXISTS skill_verified_distributions;
    DROP TABLE IF EXISTS skill_conformance_attestations;
    DROP TABLE IF EXISTS skill_release_claims;
  `);
  initializeCurrentSchema(databaseDriver);
}
