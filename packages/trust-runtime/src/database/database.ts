import type { Generated, Kysely } from "kysely";

import type { Attempt, CheckSnapshot, Session } from "../model.js";

export interface EnvironmentTable {
  name: string;
  created_at: string;
  updated_at: string;
}

export interface EnvironmentVariableTable {
  environment: string;
  name: string;
  value: string;
  updated_at: string;
}

export interface EnvironmentCredentialTable {
  environment: string;
  name: string;
  value: string;
  updated_at: string;
}

export interface PublishedProcedureTable {
  procedure_name: string;
  procedure_version: string;
  definition_digest: string;
  source_name: string;
  source: string;
  compiled_procedure_json: string;
  published_by: string;
  published_at: string;
}

export interface PlanTable {
  plan_slug: string;
  procedure_name: string;
  procedure_version: string;
  environment: string;
  mode: string;
  intent_chaining: number;
  intent_chain_state: string;
  current_intent: string | null;
  current_intent_check_uri: string | null;
  current_intent_attempt_key: string | null;
  root_inputs_json: string;
  current_revision: number;
  created_at: string;
}

export interface PlanRevisionTable {
  id: Generated<number>;
  plan_slug: string;
  revision: number;
  definition_digest: string;
  source: string;
  declarations_json: string;
  role_values_json: string;
  check_values_json: string;
  compiled_at: string;
}

export interface CompiledCheckTable {
  plan_slug: string;
  plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  check_json: string;
}

export interface SessionTable {
  session_id: string;
  plan_slug: string;
  state: Session["state"];
  opened_at: string;
  expires_at: string;
  closed_at: string | null;
}

export interface AttemptTable {
  attempt_handle: string;
  attempt_key: string;
  plan_slug: string;
  plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  session_id: string;
  operation: string;
  operation_digest: string;
  action_input_json: string;
  environment: string;
  reobserve: number;
  intent: string | null;
  next_intent: string | null;
  state: Attempt["state"];
  admitted_at: string;
  expires_at: string;
  finalized_at: string | null;
  finalization_json: string | null;
}

export interface FactTable {
  fact_id: string;
  check_uri: string;
  compiled_digest: string;
  fact_index: number;
  operation: string;
  operation_digest: string;
  observed_at: string;
  payload_json: string;
}

export interface AttemptFactReceiptTable {
  attempt_handle: string;
  fact_id: string;
  fact_index: number;
  recorded_at: string;
}

export interface CheckSnapshotTable {
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

export interface ActiveCheckQualificationTable {
  plan_slug: string;
  plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  snapshot_id: string;
  activation_digest: string;
}

export interface TrustDatabase {
  environments: EnvironmentTable;
  environment_variables: EnvironmentVariableTable;
  environment_credentials: EnvironmentCredentialTable;
  published_procedures: PublishedProcedureTable;
  plans: PlanTable;
  plan_revisions: PlanRevisionTable;
  compiled_checks: CompiledCheckTable;
  sessions: SessionTable;
  attempts: AttemptTable;
  facts: FactTable;
  attempt_fact_receipts: AttemptFactReceiptTable;
  check_snapshots: CheckSnapshotTable;
  active_check_qualifications: ActiveCheckQualificationTable;
}

export type Database = Kysely<TrustDatabase>;
