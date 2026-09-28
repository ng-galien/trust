import { sql } from "kysely";
import type { Database } from "../database/database.js";

const readScopes = new WeakMap<Database, Map<string, Promise<unknown>>>();

/**
 * Within one read-only Plan transaction nothing can change, so repeated lookups of the same Plan or revision
 * share one result. Outside such a transaction every call reads the database.
 */
export function readOnce<T>(database: Database, key: string, read: () => Promise<T>): Promise<T> {
  const scope = readScopes.get(database);
  if (!scope) return read();
  let value = scope.get(key) as Promise<T> | undefined;
  if (!value) {
    value = read();
    scope.set(key, value);
  }
  return value;
}

/** Serialize one composition before taking any Attempt lock; unrelated roots remain concurrent. */
export async function planTransaction<T>(
  database: Database,
  plan: string,
  work: (transaction: Database) => Promise<T>,
): Promise<T> {
  return database.transaction().execute(async (transaction) => {
    const root = await compositionRoot(transaction, plan);
    // Also serializes initial engagement, when there is no Plan row to lock yet.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`trust.plan:${root}`}, 0))`.execute(transaction);
    await transaction.selectFrom("plans").select("plan_slug").where("plan_slug", "=", root).forUpdate().execute();
    return work(transaction);
  });
}

/**
 * Read one composition consistently without serializing readers: the shared lock waits for a writer of the
 * same root and excludes new writers until the read commits, while concurrent reads proceed together.
 */
export async function planReadTransaction<T>(
  database: Database,
  plan: string,
  work: (transaction: Database) => Promise<T>,
): Promise<T> {
  return database.transaction().execute(async (transaction) => {
    await sql`set transaction read only`.execute(transaction);
    readScopes.set(transaction, new Map());
    const root = await compositionRoot(transaction, plan);
    await sql`select pg_advisory_xact_lock_shared(hashtextextended(${`trust.plan:${root}`}, 0))`.execute(transaction);
    return work(transaction);
  });
}

async function compositionRoot(transaction: Database, plan: string): Promise<string> {
  let root = plan;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(root)) throw new Error("Cyclic child Plan relation");
    seen.add(root);
    // Keep following superseded links: historical children share the same governance lock.
    const parent = await transaction
      .selectFrom("child_generations")
      .select("parent_plan")
      .where("child_plan", "=", root)
      .executeTakeFirst();
    if (!parent) return root;
    root = parent.parent_plan;
  }
}
