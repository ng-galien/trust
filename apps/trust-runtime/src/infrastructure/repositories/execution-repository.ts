import type { Execution } from "../../domain/runtime-model.js";
import type { DatabaseDriver, DatabaseRow } from "../../ports/database.js";

interface ExecutionRow extends DatabaseRow {
  execution_handle: string;
  attempt_key: string;
  plan_slug: string;
  plan_revision: number;
  check_uri: string;
  compiled_digest: string;
  session_id: string;
  capability: string;
  action_contract_digest: string;
  action_input_json: string;
  materialization_contract_json: string;
  release_digest: string;
  environment: string;
  deployment_key: string;
  envelope: Execution["envelope"];
  runtime_identity: string;
  process_identity: string;
  state: Execution["state"];
  granted_at: string;
  expires_at: string;
  finalized_at: string | null;
}

const EXECUTION_COLUMNS = `execution_handle, attempt_key, plan_slug, plan_revision, check_uri,
  compiled_digest, session_id,
  capability, action_contract_digest, action_input_json, materialization_contract_json,
  release_digest,
  environment, deployment_key, envelope, runtime_identity, process_identity,
  state, granted_at, expires_at, finalized_at`;

export class ExecutionRepository {
  constructor(private readonly dependencies: { databaseDriver: DatabaseDriver }) {}

  create(execution: Execution): void {
    this.dependencies.databaseDriver
      .prepare(
        `INSERT INTO executions (${EXECUTION_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.handle,
        execution.attemptKey,
        execution.planSlug,
        execution.planRevision,
        execution.checkUri,
        execution.compiledCheckDigest,
        execution.sessionId,
        execution.capability,
        execution.actionContractDigest,
        JSON.stringify(execution.actionInput),
        JSON.stringify(execution.materializationContract),
        execution.releaseDigest,
        execution.environment,
        execution.deploymentKey,
        execution.envelope,
        execution.runtimeIdentity,
        execution.processIdentity,
        execution.state,
        execution.grantedAt,
        execution.expiresAt,
        execution.finalizedAt ?? null,
      );
  }

  findByAttemptKey(attemptKey: string): Execution | undefined {
    const row = this.dependencies.databaseDriver
      .prepare(`SELECT ${EXECUTION_COLUMNS} FROM executions WHERE attempt_key = ?`)
      .get<ExecutionRow>(attemptKey);
    return row ? toExecution(row) : undefined;
  }

  findByHandle(handle: string): Execution | undefined {
    const row = this.dependencies.databaseDriver
      .prepare(`SELECT ${EXECUTION_COLUMNS} FROM executions WHERE execution_handle = ?`)
      .get<ExecutionRow>(handle);
    return row ? toExecution(row) : undefined;
  }

  changeState(handle: string, state: Execution["state"], finalizedAt?: string): void {
    const result = this.dependencies.databaseDriver
      .prepare("UPDATE executions SET state = ?, finalized_at = ? WHERE execution_handle = ?")
      .run(state, finalizedAt ?? null, handle);
    if (Number(result.changes) !== 1) {
      throw new Error(`unknown execution: ${handle}`);
    }
  }
}

function toExecution(row: ExecutionRow): Execution {
  return {
    handle: row.execution_handle,
    attemptKey: row.attempt_key,
    planSlug: row.plan_slug,
    planRevision: row.plan_revision,
    checkUri: row.check_uri,
    compiledCheckDigest: row.compiled_digest,
    sessionId: row.session_id,
    capability: row.capability,
    actionContractDigest: row.action_contract_digest,
    actionInput: JSON.parse(row.action_input_json) as Record<string, unknown>,
    materializationContract: JSON.parse(row.materialization_contract_json) as Execution["materializationContract"],
    releaseDigest: row.release_digest,
    environment: row.environment,
    deploymentKey: row.deployment_key,
    envelope: row.envelope,
    runtimeIdentity: row.runtime_identity,
    processIdentity: row.process_identity,
    state: row.state,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    ...(row.finalized_at ? { finalizedAt: row.finalized_at } : {}),
  };
}
