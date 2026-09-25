#!/usr/bin/env node
import { importSqlite } from "../dist/src/database/import-sqlite.js";

const args = process.argv.slice(2);
const usage =
  "Usage: node packages/trust-runtime/scripts/import-sqlite.mjs --source <SQLite file> --operations <directory> --archive <new directory> (--pglite <new directory> | --postgresql-env <connection-string environment variable>)";
try {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (
      !["--source", "--operations", "--archive", "--pglite", "--postgresql-env"].includes(key) ||
      values.has(key) ||
      !args[index + 1]
    )
      throw new Error(usage);
    values.set(key, args[index + 1]);
  }
  if (
    !values.has("--source") ||
    !values.has("--operations") ||
    !values.has("--archive") ||
    values.has("--pglite") === values.has("--postgresql-env")
  )
    throw new Error(usage);
  const target = values.has("--pglite")
    ? { kind: "pglite", directory: values.get("--pglite") }
    : { kind: "postgresql", connectionString: process.env[values.get("--postgresql-env")] };
  if (target.kind === "postgresql" && !target.connectionString)
    throw new Error("The selected PostgreSQL connection-string environment variable is empty");
  const manifest = await importSqlite({
    source: values.get("--source"),
    operationsDirectory: values.get("--operations"),
    archiveDirectory: values.get("--archive"),
    target,
  });
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  // Import validation messages contain table/column coordinates, never row contents or credentials.
  console.error(error instanceof Error ? error.message : "SQLite import failed");
  process.exitCode = 1;
}
