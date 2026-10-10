import { type Dialect, PostgresDialect } from "kysely";
import pg from "pg";
import { DATABASE_PARSERS } from "./codecs.js";
import { DatabaseOwnershipError } from "./ownership.js";
import { preparePostgresSchema } from "./postgres-schema.js";

// Advisory locks are database-local. Keep one dedicated session for the runtime lifetime.
const OWNER_NAMESPACE = 0x54525553;
const OWNER_RESOURCE = 0x53544f52;

export async function createPostgresDialect(connectionString: string): Promise<Dialect> {
  const protocol = new URL(connectionString).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") throw new Error("Expected a PostgreSQL database URL");
  const configuration: pg.ClientConfig = {
    connectionString,
    application_name: "trust-runtime",
    connectionTimeoutMillis: 5_000,
    pipeline: false,
    types: {
      getTypeParser: (oid: number, format?: "text" | "binary") =>
        DATABASE_PARSERS[oid] ?? pg.types.getTypeParser(oid, format),
    },
  };
  const owner = new pg.Client({ ...configuration, application_name: "trust-runtime-owner" });
  const clients = new Set<pg.PoolClient>();
  let closed = false;
  let releasingOwnership = false;
  let ownershipLost = false;
  const assertOwner = (): void => {
    if (closed || ownershipLost)
      throw new DatabaseOwnershipError("PostgreSQL runtime database ownership is unavailable");
  };
  const pool = new pg.Pool({
    ...configuration,
    max: 8,
    // The pool awaits initialization and destroys a failed client before checkout.
    // Kysely acquisition hooks run after checkout without releasing on hook failure.
    onConnect: async (client) => {
      assertOwner();
      await client.query("SET search_path = public, pg_catalog");
      await client.query("SET TIME ZONE 'UTC'");
    },
  });
  const loseOwnership = (): void => {
    if (releasingOwnership || ownershipLost) return;
    ownershipLost = true;
    // Stop existing pool sessions too: a lost owner must not leave writable transactions alive.
    for (const client of clients) void client.end().catch(() => {});
  };
  owner.on("error", loseOwnership);
  owner.on("end", loseOwnership);
  pool.on("connect", (client) => {
    clients.add(client);
  });
  pool.on("remove", (client) => {
    clients.delete(client);
  });
  pool.on("error", () => {
    /* Query callers observe their own connection errors. */
  });
  try {
    await owner.connect();
    const lock = await owner.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS acquired", [
      OWNER_NAMESPACE,
      OWNER_RESOURCE,
    ]);
    if (lock.rows[0]?.acquired !== true) {
      throw new DatabaseOwnershipError("PostgreSQL database is already owned by another TRUST runtime");
    }
    await preparePostgresSchema({
      query: (sql, parameters) => owner.query(sql, parameters),
      exec: (sql) => owner.query(sql),
    });
    assertOwner();
  } catch (error) {
    closed = true;
    await pool.end();
    releasingOwnership = true;
    await owner.end().catch(() => {});
    throw error;
  }

  return new PostgresDialect({
    // Cancellation must not wait for another connection from the same saturated pool.
    controlClient: pg.Client,
    pool: {
      options: configuration,
      async connect() {
        assertOwner();
        const client = await pool.connect();
        try {
          assertOwner();
        } catch (error) {
          client.release(true);
          throw error;
        }
        return client;
      },
      async end() {
        if (closed) return;
        closed = true;
        // Hold ownership until every pooled transaction has finished and its connection is closed.
        try {
          await pool.end();
        } finally {
          releasingOwnership = true;
          await owner.end();
        }
      },
    },
  });
}
