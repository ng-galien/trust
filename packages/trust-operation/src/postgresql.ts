import type { JsonValue } from "./json.js";

/** One PostgreSQL statement authored by the Operation. The complete Operation Input is supplied
    as the single `$1` parameter and is cast by the statement when needed. */
export interface Postgresql {
  readonly connection: { readonly environment: string };
  readonly statement: string;
}

/** A PostgreSQL step accepts exactly one row containing one JSONB column named `result`. */
export interface PostgresqlResult {
  readonly result: JsonValue;
}
