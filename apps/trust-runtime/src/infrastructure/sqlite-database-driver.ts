import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  DatabaseDriver,
  DatabaseRow,
  DatabaseStatement,
  SqlParameter,
  StatementResult,
} from "../ports/database.js";

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

  close(): void {
    if (this.#database.isOpen) {
      this.#database.close();
    }
  }
}
