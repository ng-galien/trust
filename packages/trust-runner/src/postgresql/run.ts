import type { JsonValue, Postgresql, PostgresqlResult } from "@trust/operation";
import { Client, type ClientConfig } from "pg";
import type { StepReporter } from "../diagnostics/events.js";
import type { JsonObject } from "../lib/json.js";

const JSONB_OID = 3_802;

export interface PostgresqlRunnerConfiguration {
  readonly timeoutMs?: number;
}

export class PostgresqlError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresqlError";
  }
}

/** Execute the Operation-authored statement once. PostgreSQL owns atomicity and coordination:
    the runner passes the complete Input as one parameter and does not interpret the statement.
    The connection authenticates only with the Credential the step references (`authenticated by
    Credential`); no Runner process variable or password file supplies a password. */
export async function runPostgresql(
  postgresql: Postgresql,
  input: JsonObject,
  environment: JsonObject,
  reporter: StepReporter,
  configuration: PostgresqlRunnerConfiguration = {},
  resolveCredential: (credential: string) => string = undelegated,
): Promise<PostgresqlResult> {
  const connectionValue = environment[postgresql.connection.environment];
  if (typeof connectionValue !== "string") {
    throw new TypeError(`PostgreSQL Environment "${postgresql.connection.environment}" must be a connection string.`);
  }
  const connectionString = postgresConnectionString(connectionValue, postgresql.connection.environment);
  const password =
    postgresql.authentication === undefined ? "" : resolveCredential(postgresql.authentication.credential);
  const client = new Client(clientConfiguration(connectionString, configuration.timeoutMs));
  // An explicit password, empty without a Credential, stops pg from reading the process environment or a password file.
  client.password = password;
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const response = await client.query({
      text: postgresql.statement,
      values: [input],
      rowMode: "array",
    });
    if (
      response.fields.length !== 1 ||
      response.fields[0]?.name !== "result" ||
      response.fields[0]?.dataTypeID !== JSONB_OID ||
      response.rows.length !== 1
    ) {
      throw new PostgresqlError("PostgreSQL statement must return exactly one row with one JSONB column named result.");
    }
    const row = response.rows[0];
    if (!Array.isArray(row) || row.length !== 1) {
      throw new PostgresqlError("PostgreSQL statement must return exactly one row with one JSONB column named result.");
    }
    const result = json(row[0], "PostgreSQL JSONB result");
    reporter.log("postgresql", "PostgreSQL statement returned one JSONB result.");
    return { result };
  } catch (error) {
    if (error instanceof PostgresqlError) throw error;
    throw new PostgresqlError(
      `PostgreSQL statement failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (connected) await client.end().catch(() => undefined);
  }
}

function postgresConnectionString(value: string, environment: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError(`PostgreSQL Environment "${environment}" must be a PostgreSQL URL.`, {
      cause: error,
    });
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TypeError(`PostgreSQL Environment "${environment}" must use postgres:// or postgresql://.`);
  }
  if (url.password !== "") {
    throw new TypeError(
      `PostgreSQL Environment "${environment}" must not contain a password; reference a Credential with authenticated by Credential.`,
    );
  }
  if (url.hash !== "") {
    throw new TypeError(`PostgreSQL Environment "${environment}" must not contain a fragment.`);
  }
  return url.toString();
}

function clientConfiguration(connectionString: string, timeoutMs?: number): ClientConfig {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new TypeError("PostgreSQL timeoutMs must be a positive integer.");
  }
  return {
    connectionString,
    ...(timeoutMs === undefined ? {} : { connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs }),
  };
}

function undelegated(credential: string): string {
  throw new PostgresqlError(`Credential "${credential}" was not delegated to this PostgreSQL step.`);
}

function json(value: unknown, label: string): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new PostgresqlError(`${label} is not JSON.`);
  return JSON.parse(serialized) as JsonValue;
}
