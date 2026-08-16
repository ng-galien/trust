import { Kysely, SqliteDialect } from "kysely";

import type { DatabaseDriver } from "../sqlite/database.js";

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

export interface TrustDatabase {
  environments: EnvironmentTable;
  environment_variables: EnvironmentVariableTable;
  environment_credentials: EnvironmentCredentialTable;
}

export type Database = Kysely<TrustDatabase>;

export function createDatabase({ databaseDriver }: { readonly databaseDriver: DatabaseDriver }): Database {
  return new Kysely<TrustDatabase>({
    dialect: new SqliteDialect({ database: databaseDriver.kyselyDatabase() }),
  });
}
