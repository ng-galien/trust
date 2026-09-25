import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { postgresOptions, postgresOptionsWithPassword } from "../postgres-db.mjs";

const tables = [
  "push_keys",
  "projects",
  "conversations",
  "post_templates",
  "items",
  "subjects",
  "subject_links",
  "article_versions",
  "article_aliases",
  "forms",
  "form_fields",
  "form_options",
  "responses",
  "response_values",
  "push_subscriptions",
  "push_deliveries",
];

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, part]) => [key, canonical(part)]),
    );
  return value;
}

function rowsEqual(source, target) {
  const ordered = (rows) => rows.map((row) => JSON.stringify(canonical(row))).sort();
  return JSON.stringify(ordered(source)) === JSON.stringify(ordered(target));
}

function orderItems(rows) {
  const pending = new Map(rows.map((row) => [row.id, row]));
  const result = [];
  while (pending.size) {
    const available = [...pending.values()].filter((row) => !row.supersedes || !pending.has(row.supersedes));
    if (!available.length) throw new Error("Item revision chain contains a cycle.");
    available.sort((a, b) => a.id.localeCompare(b.id));
    for (const row of available) {
      result.push(row);
      pending.delete(row.id);
    }
  }
  return result;
}

const [sourcePath, databaseUrl, passwordFile] = process.argv.slice(2);
if (!sourcePath || !path.isAbsolute(sourcePath) || !databaseUrl)
  throw new Error(
    "Usage: node migrate-pglite-v5-to-postgres.mjs /absolute/closed-pglite-copy postgresql://app@127.0.0.1:PORT/database [APP_PASSWORD_FILE]",
  );

const source = await PGlite.create(sourcePath);
const target = new pg.Client(
  passwordFile
    ? postgresOptionsWithPassword(databaseUrl, (await readFile(passwordFile, "utf8")).trim())
    : postgresOptions(databaseUrl),
);
let targetConnected = false;
try {
  const version = (await source.query("SELECT version FROM trust_mobile_companion.schema_version")).rows;
  if (version.length !== 1 || version[0].version !== 5)
    throw new Error("Source must be a closed PGlite schema v5 copy.");
  await target.connect();
  targetConnected = true;
  await target.query("BEGIN");
  const existing = await target.query("SELECT 1 FROM pg_namespace WHERE nspname='trust_mobile_companion'");
  if (existing.rowCount)
    throw new Error("Target schema already exists; migration requires an empty PostgreSQL database.");
  await target.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  const counts = {};
  for (const table of tables) {
    const sourceRows = (await source.query(`SELECT * FROM trust_mobile_companion.${table}`)).rows;
    const rows = table === "items" ? orderItems(sourceRows) : sourceRows;
    for (const row of rows) {
      const columns = Object.keys(row);
      const names = columns.map((name) => {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Unexpected source column.");
        return `"${name}"`;
      });
      const placeholders = columns.map((_, index) => `$${index + 1}`);
      await target.query(
        `INSERT INTO trust_mobile_companion.${table} (${names.join(",")}) VALUES (${placeholders.join(",")})`,
        columns.map((name) => row[name]),
      );
    }
    const targetRows = (await target.query(`SELECT * FROM trust_mobile_companion.${table}`)).rows;
    if (!rowsEqual(sourceRows, targetRows)) throw new Error(`Migration comparison failed for ${table}.`);
    counts[table] = rows.length;
  }
  await target.query("COMMIT");
  console.log(JSON.stringify({ schemaVersion: 5, counts, dataUnchanged: true }));
} catch (error) {
  if (targetConnected) await target.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await source.close();
  if (targetConnected) await target.end();
}
