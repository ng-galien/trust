import { sql } from "kysely";
import type { Database } from "../database/database.js";

/** Serialize one composition before taking any Attempt lock; unrelated roots remain concurrent. */
export async function planTransaction<T>(
  database: Database,
  plan: string,
  work: (transaction: Database) => Promise<T>,
): Promise<T> {
  return database.transaction().execute(async (transaction) => {
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
      if (!parent) break;
      root = parent.parent_plan;
    }
    // Also serializes initial engagement, when there is no Plan row to lock yet.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`trust.plan:${root}`}, 0))`.execute(transaction);
    await transaction.selectFrom("plans").select("plan_slug").where("plan_slug", "=", root).forUpdate().execute();
    return work(transaction);
  });
}
