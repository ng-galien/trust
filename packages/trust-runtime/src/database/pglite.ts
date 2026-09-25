import { PGlite } from "@electric-sql/pglite";
import {
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";
import { DATABASE_PARSERS } from "./codecs.js";
import { ownEmbeddedDirectory } from "./ownership.js";
import { preparePostgresSchema } from "./postgres-schema.js";

export async function createPgliteDialect(directory: string): Promise<Dialect> {
  const ownership = await ownEmbeddedDirectory(directory);
  let pglite: PGlite | undefined;
  try {
    const connected = await PGlite.create({ dataDir: ownership.directory, parsers: DATABASE_PARSERS });
    pglite = connected;
    await preparePostgresSchema({
      query: (sql, parameters) => connected.query<Record<string, unknown>>(sql, parameters),
      exec: (sql) => connected.exec(sql),
    });
    return new PgliteDialect(pglite, ownership.release);
  } catch (error) {
    // If close fails, keep the ownership marker: uncertain storage is not safe to reopen.
    await pglite?.close();
    await ownership.release();
    throw error;
  }
}

class PgliteDialect implements Dialect {
  constructor(
    private readonly database: PGlite,
    private readonly releaseOwnership: () => Promise<void>,
  ) {}

  createAdapter(): PostgresAdapter {
    return new PostgresAdapter();
  }
  createQueryCompiler(): PostgresQueryCompiler {
    return new PostgresQueryCompiler();
  }
  createIntrospector(database: Kysely<unknown>): PostgresIntrospector {
    return new PostgresIntrospector(database);
  }
  createDriver(): Driver {
    return new PgliteDriver(this.database, this.releaseOwnership);
  }
}

/** Reserve PGlite's one connection for the entire Kysely transaction, not one statement. */
class PgliteDriver implements Driver {
  readonly #connection: DatabaseConnection;
  #tail: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;
  #closed = false;

  constructor(
    private readonly database: PGlite,
    private readonly releaseOwnership: () => Promise<void>,
  ) {
    this.#connection = {
      executeQuery: async <Row>(query: CompiledQuery): Promise<QueryResult<Row>> => {
        if (this.#closed) throw new Error("PGlite database is closed");
        const result = await database.query<Row>(query.sql, [...query.parameters]);
        return {
          rows: result.rows,
          ...(/^\s*(insert|update|delete|merge)\b/i.test(query.sql)
            ? { numAffectedRows: BigInt(result.affectedRows ?? 0) }
            : {}),
        };
      },
      streamQuery<Row>(): AsyncIterableIterator<QueryResult<Row>> {
        throw new Error("PGlite streaming is not part of the TRUST persistence contract");
      },
    };
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    if (this.#closed) {
      release();
      throw new Error("PGlite database is closed");
    }
    this.#release = release;
    return this.#connection;
  }

  async releaseConnection(): Promise<void> {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const isolation = settings.isolationLevel ? ` ISOLATION LEVEL ${settings.isolationLevel}` : "";
    const access = settings.accessMode ? ` ${settings.accessMode}` : "";
    await connection.executeQuery(CompiledQuery.raw(`BEGIN${isolation}${access}`));
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async destroy(): Promise<void> {
    await this.#tail;
    if (this.#closed) return;
    this.#closed = true;
    await this.database.close();
    await this.releaseOwnership();
  }
}
