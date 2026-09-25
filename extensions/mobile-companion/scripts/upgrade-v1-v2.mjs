import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { preparePushKeys } from "../push.mjs";

const tables = [
  ["projects", "id"],
  ["items", "id"],
  ["forms", "item"],
  ["form_fields", "item, field_id"],
  ["form_options", "item, field_id, value"],
  ["responses", "item"],
  ["response_values", "item, field_id"],
];

async function snapshot(db) {
  const hash = createHash("sha256");
  const counts = {};
  for (const [table, order] of tables) {
    const rows = (await db.query(`SELECT * FROM trust_mobile_companion.${table} ORDER BY ${order}`)).rows;
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

function requireVersion(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} requires mobile schema v${expected}; found v${actual}.`);
}

export async function upgradeV1ToV2(sourceDirectory, backupDirectory) {
  if (!path.isAbsolute(sourceDirectory) || !path.isAbsolute(backupDirectory))
    throw new Error("Source and backup must be absolute directories.");
  const [source, backup] = await Promise.all([realpath(sourceDirectory), realpath(backupDirectory)]);
  for (const directory of [source, backup]) {
    if (!(await stat(directory)).isDirectory()) throw new Error("Source and backup must be directories.");
  }
  if (source === backup || source.startsWith(`${backup}${path.sep}`) || backup.startsWith(`${source}${path.sep}`))
    throw new Error("Source and backup must be separate, non-nested directories.");

  // PGlite can write housekeeping state on open. Inspect a copy so the backup remains untouched.
  const scratch = await mkdtemp(path.join(tmpdir(), "trust-mobile-backup-check-"));
  const backupInspection = path.join(scratch, "pglite");
  let db;
  try {
    await cp(backup, backupInspection, { recursive: true });
    db = await PGlite.create(backupInspection);
    requireVersion(await version(db), 1, "Backup");
    const before = await snapshot(db);
    await db.close();
    db = await PGlite.create(source);
    requireVersion(await version(db), 1, "Source");
    const sourceBefore = await snapshot(db);
    if (sourceBefore.digest !== before.digest)
      throw new Error("Source and backup legacy data differ; migration refused.");
    const sql = await readFile(new URL("../migration-v1-v2.sql", import.meta.url), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await preparePushKeys(tx);
    });
    requireVersion(await version(db), 2, "Migrated source");
    const after = await snapshot(db);
    if (after.digest !== before.digest)
      throw new Error("Legacy data changed during migration; keep the backup for recovery.");
    return { version: 2, counts: after.counts, legacyDataUnchanged: true };
  } finally {
    await db?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 4)
      throw new Error("Usage: node scripts/upgrade-v1-v2.mjs <offline-source-directory> <backup-directory>");
    const result = await upgradeV1ToV2(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
