import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const tables = [
  ["projects", "id"],
  ["items", "id", "id,project,kind,title,summary,body,document_url,plan,created_at"],
  ["forms", "item"],
  ["form_fields", "item, field_id"],
  ["form_options", "item, field_id, value"],
  ["responses", "item"],
  ["response_values", "item, field_id"],
  ["push_keys", "id"],
  ["push_subscriptions", "endpoint"],
  ["push_deliveries", "item, endpoint"],
];

async function snapshot(db) {
  const hash = createHash("sha256");
  const counts = {};
  for (const [table, order, columns = "*"] of tables) {
    const rows = (await db.query(`SELECT ${columns} FROM trust_mobile_companion.${table} ORDER BY ${order}`)).rows;
    counts[table] = rows.length;
    hash.update(JSON.stringify([table, rows]));
  }
  return { digest: hash.digest("hex"), counts };
}

async function version(db) {
  const rows = (await db.query("SELECT version FROM trust_mobile_companion.schema_version")).rows;
  if (rows.length !== 1) throw new Error("Expected exactly one mobile schema version row.");
  return rows[0].version;
}

export async function upgradeV2ToV3(sourceDirectory, backupDirectory) {
  if (!path.isAbsolute(sourceDirectory) || !path.isAbsolute(backupDirectory))
    throw new Error("Source and backup must be absolute directories.");
  const [source, backup] = await Promise.all([realpath(sourceDirectory), realpath(backupDirectory)]);
  for (const directory of [source, backup]) {
    if (!(await stat(directory)).isDirectory()) throw new Error("Source and backup must be directories.");
  }
  if (source === backup || source.startsWith(`${backup}${path.sep}`) || backup.startsWith(`${source}${path.sep}`))
    throw new Error("Source and backup must be separate, non-nested directories.");

  // Opening PGlite may write housekeeping files, so inspect a copy of the backup.
  const scratch = await mkdtemp(path.join(tmpdir(), "trust-mobile-v2-backup-check-"));
  const backupInspection = path.join(scratch, "pglite");
  let db;
  try {
    await cp(backup, backupInspection, { recursive: true });
    db = await PGlite.create(backupInspection);
    if ((await version(db)) !== 2) throw new Error("Backup requires mobile schema v2.");
    const before = await snapshot(db);
    await db.close();
    db = await PGlite.create(source);
    if ((await version(db)) !== 2) throw new Error("Source requires mobile schema v2.");
    if ((await snapshot(db)).digest !== before.digest)
      throw new Error("Source and backup data differ; upgrade refused.");
    const sql = await readFile(new URL("../migration-v2-v3.sql", import.meta.url), "utf8");
    await db.transaction(async (tx) => tx.exec(sql));
    if ((await version(db)) !== 3) throw new Error("Upgrade did not install schema v3.");
    const after = await snapshot(db);
    if (after.digest !== before.digest) throw new Error("Data changed during upgrade; keep the backup for recovery.");
    return { version: 3, counts: after.counts, dataUnchanged: true };
  } finally {
    await db?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 4)
      throw new Error("Usage: node scripts/upgrade-v2-v3.mjs <offline-candidate-directory> <backup-directory>");
    console.log(JSON.stringify(await upgradeV2ToV3(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
