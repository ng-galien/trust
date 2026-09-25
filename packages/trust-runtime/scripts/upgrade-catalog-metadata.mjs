import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  PRE_CATALOG_METADATA_SCHEMA_DIGEST,
  SQLITE_SCHEMA_DIGEST,
  upgradeCatalogMetadataSchema,
} from "../src/database/sqlite-schema.ts";

const [databaseArgument, backupArgument] = process.argv.slice(2);
if (!databaseArgument || !backupArgument) {
  throw new Error(
    "Usage: node packages/trust-runtime/scripts/upgrade-catalog-metadata.mjs <database.sqlite> <new-backup.sqlite>",
  );
}
const databasePath = resolve(databaseArgument);
const backupPath = resolve(backupArgument);
if (databasePath === backupPath || !existsSync(databasePath) || existsSync(backupPath)) {
  throw new Error("Database must exist and backup path must be distinct and unused");
}

const source = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
try {
  const digest = source.prepare("SELECT digest FROM trust_schema WHERE singleton = 1").get()?.digest;
  if (digest !== PRE_CATALOG_METADATA_SCHEMA_DIGEST) throw new Error("Unexpected source schema; no upgrade performed");
  if (source.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
    throw new Error("Source database integrity check failed");
  }
  mkdirSync(dirname(backupPath), { recursive: true });
  await backup(source, backupPath);
} finally {
  source.close();
}

const snapshot = new DatabaseSync(backupPath, { readOnly: true, allowExtension: false });
try {
  if (
    snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
    snapshot.prepare("SELECT digest FROM trust_schema WHERE singleton = 1").get()?.digest !==
      PRE_CATALOG_METADATA_SCHEMA_DIGEST
  ) {
    throw new Error("Backup verification failed; no upgrade performed");
  }
} finally {
  snapshot.close();
}

const database = new DatabaseSync(databasePath, { allowExtension: false, timeout: 5_000 });
try {
  upgradeCatalogMetadataSchema(database);
  if (database.prepare("SELECT digest FROM trust_schema WHERE singleton = 1").get()?.digest !== SQLITE_SCHEMA_DIGEST) {
    throw new Error("Upgraded schema digest was not persisted");
  }
  console.log(`Catalog metadata schema upgraded. Verified backup: ${backupPath}`);
} finally {
  database.close();
}
