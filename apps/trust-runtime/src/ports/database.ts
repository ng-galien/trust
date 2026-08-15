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
  close(): void;
}
