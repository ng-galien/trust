import type { CredentialSource } from "./credential.js";
import type { JsonValue } from "./json.js";

/** One PostgreSQL statement authored by the Operation. The complete Operation Input is supplied
    as the single `$1` parameter and is cast by the statement when needed. */
export interface Postgresql {
  readonly connection: { readonly environment: string };
  readonly statement: string;
  /** `authenticated by Credential "<name>"`: the connection password comes from this declared
      Credential. Absent when the connection declares no Credential. */
  readonly authentication?: CredentialSource;
}

/** A PostgreSQL step accepts exactly one row containing one JSONB column named `result`. */
export interface PostgresqlResult {
  readonly result: JsonValue;
}
