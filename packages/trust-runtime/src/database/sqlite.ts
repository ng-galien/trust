import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Kysely, SqliteDialect, type SqliteDatabase } from "kysely";

import type { Database, TrustDatabase } from "./database.js";
import { SQLITE_SCHEMA } from "./sqlite-schema.js";

export interface SqliteDatabaseDependencies {
  readonly databasePath: string;
}

export function createSqliteDatabase({ databasePath }: SqliteDatabaseDependencies): Database {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new DatabaseSync(databasePath, {
    timeout: 5_000,
    allowExtension: false,
  });
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec(SQLITE_SCHEMA);

  return new Kysely<TrustDatabase>({
    dialect: new SqliteDialect({ database: kyselySqliteDatabase(sqlite) }),
  });
}

function kyselySqliteDatabase(sqlite: DatabaseSync): SqliteDatabase {
  return {
    prepare: (sql) => {
      const statement = sqlite.prepare(sql);
      return {
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...sqliteParameters(parameters)),
        run: (parameters) => statement.run(...sqliteParameters(parameters)),
        iterate: (parameters) => statement.iterate(...sqliteParameters(parameters)),
      };
    },
    close: () => {
      if (sqlite.isOpen) sqlite.close();
    },
  };
}

function sqliteParameters(parameters: ReadonlyArray<unknown>): SQLInputValue[] {
  return parameters.map((parameter) => {
    if (
      parameter === null
      || typeof parameter === "string"
      || typeof parameter === "number"
      || typeof parameter === "bigint"
      || parameter instanceof Uint8Array
    ) {
      return parameter;
    }
    if (typeof parameter === "boolean") return parameter ? 1 : 0;
    throw new TypeError(`Unsupported SQLite parameter type: ${typeof parameter}`);
  });
}
