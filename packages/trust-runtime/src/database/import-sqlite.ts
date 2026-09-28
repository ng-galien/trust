import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { StorageConfiguration } from "@trust/extension-sdk";
import { sql } from "kysely";
import type { PlanCheck, PlanRevision } from "../model.js";
import { childInputFingerprint } from "../plan/children.js";
import { snapshotEquivalenceDigest } from "../snapshot/store.js";
import { initializeSqliteSchema, SQLITE_SCHEMA_DIGEST } from "./sqlite-schema.js";
import { createDatabase } from "./storage.js";

// Dependency order also keeps escalation admission triggers inactive until history is restored.
const TABLES = [
  "source_templates",
  "registry_sources",
  "environments",
  "environment_variables",
  "environment_credentials",
  "published_procedures",
  "catalog_metadata_revisions",
  "plans",
  "plan_revisions",
  "child_generations",
  "compiled_checks",
  "sessions",
  "attempts",
  "facts",
  "attempt_fact_receipts",
  "check_snapshots",
  "active_check_qualifications",
  "plan_escalations",
] as const;
type Row = Record<string, unknown>;
type Rows = Map<string, Row[]>;
interface Column {
  column_name: string;
  data_type: string;
}

export interface SqliteImportOptions {
  readonly source: string;
  readonly operationsDirectory: string;
  /** Must not exist. Its private backup/manifest is retained on both success and refusal. */
  readonly archiveDirectory: string;
  readonly target: StorageConfiguration;
}

export interface SqliteImportManifest {
  readonly contract: "trust.sqlite-import@1";
  readonly state: "VERIFIED";
  readonly sourceSchemaDigest: string;
  readonly source: string;
  readonly backup: string;
  readonly targetKind: StorageConfiguration["kind"];
  readonly targetIdentity: { readonly database: string; readonly version: string; readonly directory?: string };
  readonly verifiedAt: string;
  readonly tables: Record<string, { rows: number; sourceDigest: string; targetDigest: string }>;
  readonly sequences: Record<string, string>;
  readonly operations: Record<string, string>;
}

/** Explicit offline/copy tool only; normal runtime startup never loads SQLite. */
export async function importSqlite(options: SqliteImportOptions): Promise<SqliteImportManifest> {
  const sourcePath = realpathSync(options.source);
  const operationsPath = realpathSync(options.operationsDirectory);
  const archive = join(realpathSync(dirname(resolve(options.archiveDirectory))), basename(options.archiveDirectory));
  if (!lstatSync(sourcePath).isFile() || !lstatSync(operationsPath).isDirectory())
    throw new Error("Import source must be a SQLite file and an Operation directory");
  if (existsSync(archive)) throw new Error("Import archive must be a new, unused directory");
  if (inside(operationsPath, archive)) throw new Error("Import archive must be outside the source Operation directory");
  if (options.target.kind === "pglite") {
    const target = resolve(options.target.directory);
    if (options.target.directory === ":memory:" || existsSync(target))
      throw new Error("PGlite import target must be a new, unused directory");
    if (inside(operationsPath, target) || inside(archive, target) || inside(target, archive))
      throw new Error("Import target, archive and source Operation directory must be separate");
  }
  mkdirSync(archive, { mode: 0o700 });
  const backupPath = join(archive, "source.sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false });
  try {
    verifySqlite(source);
    await backup(source, backupPath);
    chmodSync(backupPath, 0o600);
  } finally {
    source.close();
  }
  const snapshot = new DatabaseSync(backupPath, { readOnly: true, allowExtension: false });
  let rows: Rows;
  let sequences: Record<string, string>;
  try {
    verifySqlite(snapshot);
    rows = new Map(
      TABLES.map((table) => {
        const statement = snapshot.prepare(`SELECT * FROM "${table}" ORDER BY rowid`);
        statement.setReadBigInts(true);
        const values = statement.all();
        const textColumns = snapshot
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .filter((column) => column.type === "TEXT")
          .map((column) => String(column.name));
        if (textColumns.length) {
          const encodedRows = snapshot
            .prepare(
              `SELECT ${textColumns.map((column) => `CAST("${column}" AS BLOB) AS "${column}"`).join(", ")} FROM "${table}" ORDER BY rowid`,
            )
            .all();
          for (const [index, value] of values.entries())
            for (const column of textColumns) {
              const encoded = encodedRows[index]?.[column];
              if (
                typeof value[column] === "string" &&
                (!(encoded instanceof Uint8Array) || !Buffer.from(value[column]).equals(encoded))
              )
                throw new Error(`Invalid UTF-8 text: ${table} row ${index + 1} column ${column}`);
            }
        }
        return [table, values];
      }),
    );
    const statement = snapshot.prepare("SELECT name, seq FROM sqlite_sequence");
    statement.setReadBigInts(true);
    sequences = Object.fromEntries(statement.all().map((row) => [String(row.name), String(row.seq)]));
  } finally {
    snapshot.close();
  }
  const operations = archiveOperations(operationsPath, join(archive, "operations"));
  // Preserve a source-only inventory even when subsequent preflight refuses a conversion.
  writePrivate(join(archive, "source-manifest.json"), {
    contract: "trust.sqlite-import-source@1",
    source: sourcePath,
    sourceSchemaDigest: SQLITE_SCHEMA_DIGEST,
    tables: Object.fromEntries(
      TABLES.map((table) => [
        table,
        { rows: tableRows(rows, table).length, digest: rowsDigest(tableRows(rows, table)) },
      ]),
    ),
    sequences,
    operations,
  });
  for (const [table, high] of Object.entries(sequences)) {
    if (BigInt(high) < 0n || BigInt(high) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(`Sequence watermark exceeds the runtime safe-number contract: ${table}`);
  }
  validateSourceValues(rows);
  backfillComparisonKeys(rows);
  const database = await createDatabase({ storage: options.target });
  try {
    const identity = (
      await sql<{
        database: string;
        version: string;
      }>`SELECT current_database() AS database, version() AS version`.execute(database)
    ).rows[0];
    if (!identity) throw new Error("Cannot identify the target database");
    const tables = await database.transaction().execute(async (transaction) => {
      for (const table of TABLES) {
        const result = await sql<{ count: string }>`SELECT count(*)::text AS count FROM ${sql.table(table)}`.execute(
          transaction,
        );
        if (result.rows[0]?.count !== "0") throw new Error(`Import target is occupied: ${table}; no rows imported`);
      }
      const summaries: SqliteImportManifest["tables"] = {};
      for (const table of TABLES) {
        const columns = (
          await sql<Column>`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`.execute(
            transaction,
          )
        ).rows;
        const original = tableRows(rows, table);
        const converted = original.map((row, index) => convertRow(table, index, row, columns));
        for (const [index, row] of converted.entries()) {
          try {
            const names = Object.keys(row);
            await sql`INSERT INTO ${sql.table(table)} (${sql.join(names.map((name) => sql.ref(name)))}) VALUES (${sql.join(names.map((name) => sql.val(row[name])))})`.execute(
              transaction,
            );
          } catch {
            throw new Error(
              `Import refused at ${table} row ${index + 1}: target constraint or type rejected the row; transaction rolled back`,
            );
          }
        }
        const actual = (await sql<Row>`SELECT * FROM ${sql.table(table)}`.execute(transaction)).rows;
        const sourceDigest = rowsDigest(converted.map((row) => comparisonRow(row, columns)));
        const targetDigest = rowsDigest(actual.map((row) => comparisonRow(row, columns)));
        if (original.length !== actual.length || sourceDigest !== targetDigest)
          throw new Error(`Imported row comparison failed for ${table}; transaction rolled back`);
        summaries[table] = { rows: actual.length, sourceDigest, targetDigest };
      }
      for (const [table, column] of [
        ["attempts", "attempt_order"],
        ["plan_revisions", "id"],
      ] as const) {
        const maximum = tableRows(rows, table).reduce(
          (value, row) => (BigInt(String(row[column])) > value ? BigInt(String(row[column])) : value),
          0n,
        );
        const retained = BigInt(sequences[table] ?? "0");
        const high = maximum > retained ? maximum : retained;
        await sql`SELECT setval(pg_get_serial_sequence(${table}, ${column}), ${String(high || 1n)}::bigint, ${high > 0n})`.execute(
          transaction,
        );
        const sequence = (
          await sql<{ sequence: string }>`SELECT pg_get_serial_sequence(${table}, ${column}) AS sequence`.execute(
            transaction,
          )
        ).rows[0]?.sequence;
        if (!sequence) throw new Error(`Missing target identity sequence: ${table}`);
        const status = (
          await sql<{
            last_value: string;
            is_called: boolean;
          }>`SELECT last_value::text AS last_value, is_called FROM ${sql.table(sequence)}`.execute(transaction)
        ).rows[0];
        if (!status || status.last_value !== String(high || 1n) || status.is_called !== high > 0n)
          throw new Error(`Sequence verification failed: ${table}`);
        sequences[table] = String(high);
      }
      return summaries;
    });
    const manifest: SqliteImportManifest = {
      contract: "trust.sqlite-import@1",
      state: "VERIFIED",
      sourceSchemaDigest: SQLITE_SCHEMA_DIGEST,
      source: sourcePath,
      backup: backupPath,
      targetKind: options.target.kind,
      targetIdentity: {
        ...identity,
        ...(options.target.kind === "pglite" ? { directory: resolve(options.target.directory) } : {}),
      },
      verifiedAt: new Date().toISOString(),
      tables,
      sequences,
      operations,
    };
    writePrivate(join(archive, "import-manifest.json"), manifest);
    return manifest;
  } finally {
    await database.destroy();
  }
}

function verifySqlite(database: DatabaseSync): void {
  if (
    database
      .prepare("PRAGMA integrity_check")
      .all()
      .some((row) => row.integrity_check !== "ok")
  )
    throw new Error("SQLite integrity check failed");
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0)
    throw new Error("SQLite foreign-key check failed");
  const expected = new DatabaseSync(":memory:");
  try {
    initializeSqliteSchema(expected);
    const schema = (db: DatabaseSync) =>
      db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all();
    if (canonical(schema(database)) !== canonical(schema(expected)))
      throw new Error("SQLite source schema differs from the supported import schema; no target opened");
    if (database.prepare("SELECT digest FROM trust_schema WHERE singleton = 1").get()?.digest !== SQLITE_SCHEMA_DIGEST)
      throw new Error("Unsupported SQLite schema digest; no target opened");
  } finally {
    expected.close();
  }
}

function archiveOperations(source: string, target: string): Record<string, string> {
  const inventory = (directory: string): Record<string, string> => {
    const result: Record<string, string> = {};
    const visit = (current: string) => {
      for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(current, item.name);
        if (item.isSymbolicLink()) throw new Error("Operation archive refuses symbolic links");
        if (item.isDirectory()) visit(path);
        else if (item.isFile()) result[relative(directory, path)] = digest(readFileSync(path));
        else throw new Error("Operation archive contains an unsupported file type");
      }
    };
    visit(directory);
    return result;
  };
  const before = inventory(source);
  mkdirSync(target, { mode: 0o700 });
  for (const file of Object.keys(before)) {
    const destination = join(target, file);
    mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    copyFileSync(join(source, file), destination);
    chmodSync(destination, 0o600);
  }
  if (canonical(before) !== canonical(inventory(target)) || canonical(before) !== canonical(inventory(source)))
    throw new Error(
      "Operation catalog changed during archive or archive verification failed; retry during a quiet publication window",
    );
  return before;
}

function validateSourceValues(tables: Rows): void {
  for (const [table, rows] of tables)
    for (const [index, row] of rows.entries())
      for (const [column, value] of Object.entries(row)) {
        const context = `${table} row ${index + 1} column ${column}`;
        if (typeof value === "string") {
          validateString(value, context);
          if (column.endsWith("_json")) parseLosslessJson(value, context);
        } else if (value instanceof Uint8Array) throw new Error(`Unsupported binary value: ${context}`);
      }
}

function convertRow(table: string, index: number, row: Row, columns: Column[]): Row {
  const result: Row = {};
  for (const [column, value] of Object.entries(row)) {
    const metadata = columns.find((item) => item.column_name === column);
    const context = `${table} row ${index + 1} column ${column}`;
    if (!metadata) throw new Error(`Unknown target column: ${context}`);
    if (value === null) {
      result[column] = null;
      continue;
    }
    if (metadata.data_type === "boolean") {
      if (value !== 0n && value !== 1n) throw new Error(`Expected 0 or 1: ${context}`);
      result[column] = value === 1n;
    } else if (metadata.data_type === "jsonb") {
      if (typeof value !== "string") throw new Error(`Expected serialized JSON: ${context}`);
      parseLosslessJson(value, context);
      result[column] = value;
    } else if (metadata.data_type === "timestamp with time zone") {
      if (
        typeof value !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
        Number.isNaN(Date.parse(value)) ||
        new Date(value).toISOString() !== value
      )
        throw new Error(`Expected canonical runtime UTC millisecond instant: ${context}`);
      result[column] = value;
    } else if (metadata.data_type === "uuid") {
      if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
        throw new Error(`Expected exact lowercase UUID: ${context}`);
      result[column] = value;
    } else if (["bigint", "integer", "smallint"].includes(metadata.data_type)) {
      if (
        typeof value !== "bigint" ||
        value > BigInt(Number.MAX_SAFE_INTEGER) ||
        value < BigInt(Number.MIN_SAFE_INTEGER)
      )
        throw new Error(`Integer is outside the runtime safe-number contract: ${context}`);
      result[column] = value.toString();
    } else result[column] = value;
  }
  const legacyIdentityColumns =
    table === "plans"
      ? ["creator_issuer", "creator_subject"]
      : table === "attempts"
        ? ["actor_issuer", "actor_subject"]
        : [];
  for (const column of columns) {
    if (Object.hasOwn(result, column.column_name)) continue;
    if (!legacyIdentityColumns.includes(column.column_name))
      throw new Error(`Unexpected target column absent from SQLite source: ${table}.${column.column_name}`);
    result[column.column_name] = null;
  }
  return result;
}

function comparisonRow(row: Row, columns: Column[]): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const type = columns.find((item) => item.column_name === key)?.data_type;
      if (value === null) return [key, null];
      if (type === "jsonb") return [key, typeof value === "string" ? JSON.parse(value) : value];
      if (["bigint", "integer", "smallint"].includes(type ?? "")) return [key, String(value)];
      if (type === "timestamp with time zone") return [key, value instanceof Date ? value.toISOString() : value];
      return [key, value];
    }),
  );
}

function backfillComparisonKeys(rows: Rows): void {
  const plans = tableRows(rows, "plans");
  const relations = tableRows(rows, "child_generations");
  for (const relation of relations) {
    if (relation.superseded_at !== null) {
      relation.comparison_fingerprint = null;
      continue;
    }
    const plan = plans.find((row) => row.plan_slug === relation.parent_plan);
    const revision = tableRows(rows, "plan_revisions").find(
      (row) => row.plan_slug === relation.parent_plan && row.revision === plan?.current_revision,
    );
    if (!plan || !revision) throw new Error("Cannot reconstruct current child generation: missing parent revision");
    const invocations = JSON.parse(String(revision.invocations_json)) as PlanRevision["invocations"];
    const invocation = invocations.find((value) => value.id === relation.invocation_id);
    if (!invocation) throw new Error("Cannot reconstruct current child generation: missing invocation");
    const checks = tableRows(rows, "compiled_checks")
      .filter((row) => row.plan_slug === relation.parent_plan && row.plan_revision === plan.current_revision)
      .sort((a, b) => Buffer.compare(Buffer.from(String(a.check_uri)), Buffer.from(String(b.check_uri))))
      .map((row) => JSON.parse(String(row.check_json)) as PlanCheck);
    const signature = {
      definition: invocation.definition.procedureDigest,
      inputs: invocation.rootInputs,
      checks: checks
        .filter((check) => invocation.scenarioDependencies.includes(check.scenario))
        .map(
          (check) =>
            tableRows(rows, "active_check_qualifications").find(
              (row) =>
                row.plan_slug === relation.parent_plan &&
                row.plan_revision === plan.current_revision &&
                row.check_uri === check.uri,
            )?.activation_digest,
        ),
      children: invocations
        .filter((value) => invocation.scenarioDependencies.includes(value.definition.scenario))
        .map((value) => {
          const current = relations.find(
            (row) =>
              row.parent_plan === relation.parent_plan && row.invocation_id === value.id && row.superseded_at === null,
          );
          const child = current ? plans.find((row) => row.plan_slug === current.child_plan) : undefined;
          return {
            id: value.id,
            generation: current ? Number(current.generation) : null,
            revision: child ? Number(child.current_revision) : null,
          };
        }),
    };
    if (digest(JSON.stringify(signature)) !== relation.input_digest)
      throw new Error(
        `Cannot verify historical child input signature for generation ${String(relation.generation)}; no target opened`,
      );
    relation.comparison_fingerprint = childInputFingerprint(signature);
  }
  for (const snapshot of tableRows(rows, "check_snapshots"))
    snapshot.equivalence_digest = snapshotEquivalenceDigest(
      String(snapshot.check_uri),
      String(snapshot.compiled_digest),
      JSON.parse(String(snapshot.fact_ids_json)),
    );
}

/** Reject duplicate keys, malformed Unicode and numeric changes before JSONB loses their spelling. */
function parseLosslessJson(source: string, context: string): unknown {
  let offset = 0;
  const fail = (reason: string): never => {
    throw new Error(`JSON import refused (${reason}): ${context}`);
  };
  const whitespace = () => {
    while (/\s/.test(source[offset] ?? "") && offset < source.length) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === "\\") {
        offset++;
        continue;
      }
      if (character === '"') {
        let value: string;
        try {
          value = JSON.parse(source.slice(start, offset)) as string;
        } catch {
          return fail("invalid string");
        }
        validateString(value, context);
        return value;
      }
    }
    return fail("unterminated string");
  };
  const value = (): void => {
    whitespace();
    if (source[offset] === '"') {
      string();
      return;
    }
    if (source[offset] === "{") {
      offset++;
      whitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset++;
        return;
      }
      while (true) {
        whitespace();
        if (source[offset] !== '"') fail("invalid object key");
        const key = string();
        if (keys.has(key)) fail("duplicate object key");
        keys.add(key);
        whitespace();
        if (source[offset++] !== ":") fail("missing colon");
        value();
        whitespace();
        const separator = source[offset++];
        if (separator === "}") return;
        if (separator !== ",") fail("invalid object separator");
      }
    }
    if (source[offset] === "[") {
      offset++;
      whitespace();
      if (source[offset] === "]") {
        offset++;
        return;
      }
      while (true) {
        value();
        whitespace();
        const separator = source[offset++];
        if (separator === "]") return;
        if (separator !== ",") fail("invalid array separator");
      }
    }
    const scalar =
      source.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0] ??
      fail("invalid scalar");
    offset += scalar.length;
    if (!/^(true|false|null)$/.test(scalar)) {
      const number = Number(scalar);
      if (!Number.isFinite(number) || decimal(scalar) !== decimal(JSON.stringify(number)))
        fail("number would lose precision");
    }
  };
  value();
  whitespace();
  if (offset !== source.length) fail("trailing content");
  try {
    return JSON.parse(source);
  } catch {
    return fail("invalid syntax");
  }
}

function decimal(value: string): string {
  const [coefficient = "", exponent = "0"] = value.toLowerCase().split("e");
  const digits = coefficient.replace(".", "").replace(/^-/, "").replace(/^0+/, "");
  if (!digits || /^0+$/.test(digits)) return "0";
  const trailing = digits.match(/0*$/)?.[0].length ?? 0;
  return `${value.startsWith("-") ? "-" : ""}${digits.slice(0, digits.length - trailing)}e${BigInt(exponent) - BigInt(coefficient.split(".")[1]?.length ?? 0) + BigInt(trailing)}`;
}

function validateString(value: string, context: string): void {
  if (value.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
    throw new Error(`PostgreSQL-incompatible Unicode: ${context}`);
}
function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item === undefined ? null : item)).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function rowsDigest(rows: Row[]): string {
  return digest(rows.map(canonical).sort().join("\n"));
}
function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function tableRows(rows: Rows, table: string): Row[] {
  const values = rows.get(table);
  if (!values) throw new Error(`Missing source table inventory: ${table}`);
  return values;
}
