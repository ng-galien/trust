import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import type { SqliteDatabase } from "kysely";

export type SqlParameter = string | number | bigint | Uint8Array | null;
export type DatabaseRow = Record<string, string | number | bigint | Uint8Array | null>;

export interface StatementResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface DatabaseStatement {
  run(...params: readonly SqlParameter[]): StatementResult;
  get<T extends DatabaseRow = DatabaseRow>(...params: readonly SqlParameter[]): T | undefined;
  all<T extends DatabaseRow = DatabaseRow>(...params: readonly SqlParameter[]): T[];
}

export interface DatabaseDriver {
  exec(sql: string): void;
  prepare(sql: string): DatabaseStatement;
  transaction<T>(work: () => T): T;
  kyselyDatabase(): SqliteDatabase;
  close(): void;
}

class NodeSqliteStatement implements DatabaseStatement {
  constructor(private readonly statement: StatementSync) {}

  run(...params: readonly SqlParameter[]): StatementResult {
    return this.statement.run(...params);
  }

  get<T extends DatabaseRow = DatabaseRow>(...params: readonly SqlParameter[]): T | undefined {
    return this.statement.get(...params) as T | undefined;
  }

  all<T extends DatabaseRow = DatabaseRow>(...params: readonly SqlParameter[]): T[] {
    return this.statement.all(...params) as T[];
  }
}

export interface SqliteDatabaseDriverDependencies {
  databasePath: string;
}

export class SqliteDatabaseDriver implements DatabaseDriver {
  readonly #database: DatabaseSync;

  constructor({ databasePath }: SqliteDatabaseDriverDependencies) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new DatabaseSync(databasePath, {
      timeout: 5_000,
      allowExtension: false,
    });
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  prepare(sql: string): DatabaseStatement {
    return new NodeSqliteStatement(this.#database.prepare(sql));
  }

  transaction<T>(work: () => T): T {
    if (this.#database.isTransaction) {
      return work();
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  kyselyDatabase(): SqliteDatabase {
    return {
      prepare: (sql) => {
        const statement = this.#database.prepare(sql);
        return {
          reader: statement.columns().length > 0,
          all: (parameters) => statement.all(...sqliteParameters(parameters)),
          run: (parameters) => statement.run(...sqliteParameters(parameters)),
          iterate: (parameters) => statement.iterate(...sqliteParameters(parameters)),
        };
      },
      // The Awilix-owned DatabaseDriver closes the shared handle. Kysely must
      // not close it independently while legacy stores still share it.
      close: () => undefined,
    };
  }

  close(): void {
    if (this.#database.isOpen) {
      this.#database.close();
    }
  }
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
