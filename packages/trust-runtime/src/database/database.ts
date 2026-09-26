import type { CatalogMetadata, TemplateParameter } from "@trust/extension-sdk";
import type { CompiledProcedure } from "@trust/procedure";
import type { ColumnType, Generated, Kysely } from "kysely";
import type { Attempt, CheckSnapshot, Plan, PlanCheck, PlanRevision, Session } from "../model.js";

/** JSONB reads are decoded by the driver; writes are explicit JSON, including root arrays. */
export type JsonColumn<T> = ColumnType<T, string, string>;
export type StoredRoleValues =
  | PlanRevision["roleValues"]
  | {
      readonly contract: "trust.plan-role-values@1";
      readonly produced: PlanRevision["roleValues"];
      readonly imported: PlanRevision["importedValues"];
    };

export interface RegistrySourceTable {
  name: string;
  kind: "git" | "http";
  url: string;
  reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceTemplateTable {
  deleted: boolean;
  id: string;
  title: string;
  description: string;
  body: string;
  parameters_json: JsonColumn<TemplateParameter[]>;
  revision: number;
}

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
  compiled_procedure_json: JsonColumn<CompiledProcedure>;
  published_by: string;
  published_at: string;
}

export interface CatalogMetadataRevisionTable {
  kind: "operation" | "procedure";
  name: string;
  version: string;
  revision: number;
  title: string;
  description: string | null;
  classification_json: JsonColumn<CatalogMetadata["classification"]>;
  updated_at: string;
}

export interface PlanTable {
  creator_issuer: Generated<string | null>;
  creator_subject: Generated<string | null>;
  plan_slug: string;
  procedure_name: string;
  procedure_version: string;
  environment: string;
  mode: string;
  intent_chaining: boolean;
  intent_chain_state: string;
  current_intent: string | null;
  current_intent_check_uri: string | null;
  current_intent_attempt_key: string | null;
  metadata_json: JsonColumn<Plan["metadata"]>;
  root_inputs_json: JsonColumn<Record<string, unknown>>;
  current_revision: number;
  created_at: string;
}

export interface PlanRevisionTable {
  resolved_procedure_json: JsonColumn<PlanRevision["resolvedProcedure"]>;
  id: Generated<number>;
  plan_slug: string;
  revision: number;
  definition_digest: string;
  source: string;
  declarations_json: JsonColumn<PlanRevision["agentDeclarations"]>;
  mission_declarations_json: JsonColumn<PlanRevision["missionDeclarations"]>;
  resolved_missions_json: JsonColumn<PlanRevision["resolvedMissions"]>;
  role_values_json: JsonColumn<StoredRoleValues>;
  check_values_json: JsonColumn<PlanRevision["checkValues"]>;
  invocations_json: JsonColumn<PlanRevision["invocations"]>;
  compiled_at: string;
}

export interface ChildGenerationTable {
  parent_plan: string;
  invocation_id: string;
  generation: number;
  child_plan: string;
  input_digest: string;
  comparison_fingerprint: string | null;
  observed_revision: number;
  created_at: string;
  superseded_at: string | null;
}

export interface CompiledCheckTable {
  plan_slug: string;
  plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  check_json: JsonColumn<PlanCheck>;
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
  actor_issuer: Generated<string | null>;
  actor_subject: Generated<string | null>;
  invocation_digest: string | null;
  attempt_order: Generated<number>;
  attempt_handle: string;
  attempt_key: string;
  execution_id: string;
  plan_slug: string;
  plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  session_id: string;
  operation: string;
  operation_digest: string;
  action_input_json: JsonColumn<Record<string, unknown>>;
  environment: string;
  reobserve: boolean;
  intent: string | null;
  next_intent: string | null;
  state: Attempt["state"];
  admitted_at: string;
  expires_at: string;
  interrupted_at: string | null;
  finalized_at: string | null;
  finalization_json: ColumnType<Attempt["finalization"] | null, string | null, string | null>;
}

export interface FactTable {
  fact_id: string;
  check_uri: string;
  compiled_digest: string;
  fact_index: number;
  operation: string;
  operation_digest: string;
  observed_at: string;
  payload_json: JsonColumn<Record<string, unknown>>;
}

export interface AttemptFactReceiptTable {
  attempt_handle: string;
  fact_id: string;
  fact_index: number;
  recorded_at: string;
}

export interface CheckSnapshotTable {
  equivalence_digest: string;
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
  fact_ids_json: JsonColumn<string[]>;
  checklist_delta_json: JsonColumn<CheckSnapshot["checklistDelta"]>;
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

export interface PlanEscalationTable {
  escalation_id: string;
  plan_slug: string;
  plan_revision: number;
  snapshot_plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  snapshot_id: string;
  attempt_handle: string;
  blocking_reason: string;
  forbidden_further_action: string;
  escalated_at: string;
  resumed_at: string | null;
  resume_reason: string | null;
}

export interface TrustDatabase {
  registry_sources: RegistrySourceTable;
  environments: EnvironmentTable;
  source_templates: SourceTemplateTable;
  environment_variables: EnvironmentVariableTable;
  environment_credentials: EnvironmentCredentialTable;
  published_procedures: PublishedProcedureTable;
  catalog_metadata_revisions: CatalogMetadataRevisionTable;
  plans: PlanTable;
  plan_revisions: PlanRevisionTable;
  child_generations: ChildGenerationTable;
  compiled_checks: CompiledCheckTable;
  sessions: SessionTable;
  attempts: AttemptTable;
  facts: FactTable;
  attempt_fact_receipts: AttemptFactReceiptTable;
  check_snapshots: CheckSnapshotTable;
  active_check_qualifications: ActiveCheckQualificationTable;
  plan_escalations: PlanEscalationTable;
}

export type Database = Kysely<TrustDatabase>;

/** Unknown public handles must remain a domain miss rather than a UUID cast error. */
export function isDatabaseUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
