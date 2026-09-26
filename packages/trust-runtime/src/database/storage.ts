import type { StorageConfiguration } from "@trust/extension-sdk";
import { matchStorageConfiguration } from "@trust/extension-sdk/match";
import { Kysely, sql } from "kysely";
import type { Database, TrustDatabase } from "./database.js";
import { createPgliteDialect } from "./pglite.js";
import { createPostgresDialect } from "./postgres.js";

/** One owned database per runtime; independent installations select independent databases. */
export async function createDatabase({ storage }: { readonly storage: StorageConfiguration }): Promise<Database> {
  const dialect = await matchStorageConfiguration(storage, {
    pglite: ({ directory }) => createPgliteDialect(directory),
    postgresql: ({ connectionString }) => createPostgresDialect(connectionString),
  });
  const database = new Kysely<TrustDatabase>({ dialect });
  try {
    // Eagerly initialize the driver so destroy() always releases its lifetime ownership.
    await sql`SELECT 1`.execute(database);
    return database;
  } catch (error) {
    await database.destroy();
    throw error;
  }
}
