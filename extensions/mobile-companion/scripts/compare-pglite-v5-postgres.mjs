import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { postgresOptionsWithPassword } from "../postgres-db.mjs";

const tables = [
  "schema_version",
  "push_keys",
  "push_subscriptions",
  "push_deliveries",
  "projects",
  "conversations",
  "subjects",
  "post_templates",
  "items",
  "subject_links",
  "article_versions",
  "article_aliases",
  "forms",
  "form_fields",
  "form_options",
  "responses",
  "response_values",
];
const [sourcePath, databaseUrl, passwordFile] = process.argv.slice(2);
if (!sourcePath || !path.isAbsolute(sourcePath) || !databaseUrl || !passwordFile)
  throw new Error(
    "Usage: node compare-pglite-v5-postgres.mjs /absolute/closed-pglite postgresql://app@127.0.0.1:PORT/database APP_PASSWORD_FILE",
  );

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
const ordered = (rows) => rows.map((row) => JSON.stringify(canonical(row))).sort();
const source = await PGlite.create(sourcePath);
const target = new pg.Client(postgresOptionsWithPassword(databaseUrl, (await readFile(passwordFile, "utf8")).trim()));
try {
  await target.connect();
  const counts = {};
  for (const table of tables) {
    const sql = `SELECT * FROM trust_mobile_companion.${table}`;
    const left = (await source.query(sql)).rows;
    const right = (await target.query(sql)).rows;
    if (JSON.stringify(ordered(left)) !== JSON.stringify(ordered(right)))
      throw new Error(`PGlite and PostgreSQL differ in ${table}.`);
    counts[table] = left.length;
  }
  console.log(JSON.stringify({ dataUnchanged: true, counts }));
} finally {
  await target.end();
  await source.close();
}
