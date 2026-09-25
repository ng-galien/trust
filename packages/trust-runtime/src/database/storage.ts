import { Kysely, sql } from "kysely";
import type { Database, TrustDatabase } from "./database.js";
import { createPgliteDialect } from "./pglite.js";
import { createPostgresDialect } from "./postgres.js";

export type StorageConfiguration =
  | { readonly kind: "pglite"; readonly directory: string }
  | { readonly kind: "postgresql"; readonly connectionString: string };

/** One owned database per runtime; independent installations select independent databases. */
export async function createDatabase({ storage }: { readonly storage: StorageConfiguration }): Promise<Database> {
  const dialect =
    storage.kind === "pglite"
      ? await createPgliteDialect(storage.directory)
      : await createPostgresDialect(storage.connectionString);
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
