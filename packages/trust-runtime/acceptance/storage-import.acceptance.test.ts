import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HistoryView, PlanView, StorageConfiguration } from "@trust/extension-sdk";
import { Client } from "pg";
import { initializeSqliteSchema } from "../src/database/sqlite-schema.js";
import { test } from "./support/fixtures.js";
import { startPublicRuntime } from "./support/runtime-process.js";

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const command = path.join(repository, "packages/trust-runtime/scripts/import-sqlite.mjs");
const instant = "2026-09-25T12:00:00.000Z";

test("SQLite import CLI preserves its source, archives Operations, verifies every table, and reopens through RPC", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-import-"));
  const target = await newTarget(directory);
  try {
    const { source, operations } = await fixture(directory);
    const before = hash(await readFile(source));
    const archive = path.join(directory, "archive");
    const result = await runImport(source, operations, archive, target.storage);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.state, "VERIFIED");
    assert.equal(Object.keys(manifest.tables).length, 18);
    assert.equal(manifest.tables.environments.rows, 1);
    assert.equal(manifest.tables.source_templates.rows, 1);
    assert.equal(manifest.sequences.attempts, "91");
    for (const table of Object.values(manifest.tables) as Array<{ sourceDigest: string; targetDigest: string }>)
      assert.equal(table.sourceDigest, table.targetDigest);
    assert.equal(
      await readFile(path.join(archive, "operations/README.txt"), "utf8"),
      "Exact Operation catalog archive\r\n",
    );
    assert.equal(hash(await readFile(source)), before);
    const archived = new DatabaseSync(path.join(archive, "source.sqlite"), { readOnly: true });
    try {
      assert.equal(archived.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(
        archived.prepare("SELECT body FROM source_templates").get()?.body,
        "Feature: source\r\n  # preserved\r\n",
      );
    } finally {
      archived.close();
    }
    for (let reopen = 0; reopen < 2; reopen++) {
      const runtime = await startPublicRuntime("trust-import-reopen-", {
        storage: target.storage,
        operationsDirectory: path.join(archive, "operations"),
      });
      try {
        const environment = await rpc<{ environments: unknown }>(runtime.endpoint, "environment.list", {});
        assert.deepEqual(environment.environments, [{ name: "imported", values: { exact: "é\r\n" } }]);
      } finally {
        await runtime.close();
      }
    }
    await assert.rejects(
      runImport(source, operations, path.join(directory, "second-archive"), target.storage),
      /occupied|unused directory/,
    );
    assert.equal(hash(await readFile(source)), before);
  } finally {
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [label, json, expected] of [
  ["duplicate keys", '[{"name":"one","name":"two"}]', /duplicate object key/],
  ["lost numeric precision", "[9007199254740993]", /number would lose precision/],
  ["JSON NUL", '["\\u0000"]', /PostgreSQL-incompatible Unicode/],
  ["unpaired surrogate", '["\\ud800"]', /PostgreSQL-incompatible Unicode/],
] as const)
  test(`SQLite import CLI refuses ${label} before opening its target`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "trust-import-refusal-"));
    try {
      const { source, operations } = await fixture(directory, json);
      const before = hash(await readFile(source));
      const destination = path.join(directory, "target");
      await assert.rejects(
        runImport(source, operations, path.join(directory, "archive"), { kind: "pglite", directory: destination }),
        expected,
      );
      assert.equal(existsSync(destination), false);
      assert.equal(existsSync(path.join(directory, "archive/source.sqlite")), true);
      assert.equal(hash(await readFile(source)), before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("SQLite online import includes committed WAL rows without changing the source files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-import-wal-"));
  const target = await newTarget(directory);
  let writer: DatabaseSync | undefined;
  try {
    const { source, operations } = await fixture(directory);
    writer = new DatabaseSync(source);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    writer.prepare("INSERT INTO environments VALUES (?, ?, ?)").run("wal-only", instant, instant);
    const mainBefore = hash(await readFile(source));
    const walBefore = hash(await readFile(`${source}-wal`));
    const archive = path.join(directory, "archive");
    const result = await runImport(source, operations, archive, target.storage);
    assert.equal(JSON.parse(result.stdout).tables.environments.rows, 2);
    const snapshot = new DatabaseSync(path.join(archive, "source.sqlite"), { readOnly: true });
    try {
      assert.equal(snapshot.prepare("SELECT name FROM environments WHERE name='wal-only'").get()?.name, "wal-only");
    } finally {
      snapshot.close();
    }
    assert.equal(hash(await readFile(source)), mainBefore);
    assert.equal(hash(await readFile(`${source}-wal`)), walBefore);
  } finally {
    writer?.close();
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite import refuses invalid UTF-8 instead of replacing historical text", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-import-utf8-"));
  try {
    const { source, operations } = await fixture(directory);
    const database = new DatabaseSync(source);
    database.exec("UPDATE source_templates SET body=CAST(x'80' AS TEXT)");
    database.close();
    const destination = path.join(directory, "target");
    await assert.rejects(
      runImport(source, operations, path.join(directory, "archive"), { kind: "pglite", directory: destination }),
      /Invalid UTF-8 text/,
    );
    assert.equal(existsSync(destination), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite import CLI rejects a forged schema marker before target writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-import-schema-"));
  try {
    const { source, operations } = await fixture(directory);
    const database = new DatabaseSync(source);
    database.exec("CREATE TABLE unexpected_private_state (value TEXT)");
    database.close();
    const destination = path.join(directory, "target");
    await assert.rejects(
      runImport(source, operations, path.join(directory, "archive"), { kind: "pglite", directory: destination }),
      /source schema differs/,
    );
    assert.equal(existsSync(destination), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained SQLite copy continues a mission collection without replacing existing child generations", {
  skip: !process.env.TRUST_IMPORT_RETAINED_SOURCE || !process.env.TRUST_IMPORT_RETAINED_OPERATIONS,
}, async ({ onTestFinished }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-retained-import-acceptance-"));
  const target = await newTarget(directory);
  const source = process.env.TRUST_IMPORT_RETAINED_SOURCE;
  const operations = process.env.TRUST_IMPORT_RETAINED_OPERATIONS;
  assert.ok(source && operations);
  const plan = process.env.TRUST_IMPORT_RETAINED_PLAN ?? "hall-npm-server-preparation-2026-09-25";
  const archive = path.join(directory, "archive");
  try {
    const result = await runImport(source, operations, archive, target.storage);
    assert.equal(JSON.parse(result.stdout).state, "VERIFIED");
    const snapshot = new DatabaseSync(path.join(archive, "source.sqlite"), { readOnly: true });
    let sourcePlans: string[];
    let sourceSnapshots: string[];
    let sourceProcedureCount: number;
    let previous: {
      revision: number;
      declarations: Record<string, unknown>;
      missions: Record<string, Array<Record<string, unknown>>>;
    };
    try {
      sourcePlans = snapshot
        .prepare("SELECT plan_slug FROM plans ORDER BY plan_slug")
        .all()
        .map((row) => String(row.plan_slug));
      sourceSnapshots = snapshot
        .prepare("SELECT snapshot_id FROM check_snapshots ORDER BY snapshot_id")
        .all()
        .map((row) => String(row.snapshot_id));
      sourceProcedureCount = Number(
        snapshot.prepare("SELECT count(*) AS count FROM published_procedures").get()?.count,
      );
      const row = snapshot
        .prepare(
          "SELECT r.* FROM plan_revisions r JOIN plans p ON p.plan_slug=r.plan_slug AND p.current_revision=r.revision WHERE p.plan_slug=?",
        )
        .get(plan);
      assert.ok(row, "The selected retained Plan must exist in the snapshot");
      previous = {
        revision: Number(row.revision),
        declarations: JSON.parse(String(row.declarations_json)),
        missions: JSON.parse(String(row.mission_declarations_json)),
      };
    } finally {
      snapshot.close();
    }
    const collection = Object.keys(previous.missions).find((key) => (previous.missions[key]?.length ?? 0) > 0);
    assert.ok(collection, "Choose a Plan with an accepted mission collection");
    const missions = structuredClone(previous.missions);
    const entries = missions[collection];
    assert.ok(entries?.[0]);
    entries.push({ ...entries[0], id: `storage-import-${randomUUID()}` });
    let original: Array<Pick<PlanView["invocations"][number], "id" | "generation" | "childPlan">> = [];
    let finalRevision = 0;
    let expectedChildren = 0;
    const first = await startPublicRuntime("trust-retained-continuation-", {
      storage: target.storage,
      operationsDirectory: path.join(archive, "operations"),
    });
    try {
      for (const retainedPlan of sourcePlans) await rpc(first.endpoint, "plan.read", { plan: retainedPlan });
      assert.equal(
        (await rpc<{ procedures: unknown[] }>(first.endpoint, "procedure.list", {})).procedures.length,
        sourceProcedureCount,
      );
      const importedSnapshots: string[] = [];
      let cursor: string | undefined;
      do {
        const history = await rpc<{ snapshots: HistoryView[]; nextCursor?: string }>(first.endpoint, "history.list", {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        importedSnapshots.push(...history.snapshots.map((snapshot) => snapshot.snapshotId));
        cursor = history.nextCursor;
      } while (cursor);
      assert.deepEqual(importedSnapshots.sort(), sourceSnapshots);
      const before = await rpc<PlanView>(first.endpoint, "plan.read", { plan });
      original = before.invocations
        .filter((value) => value.childPlan)
        .map((value) => ({ id: value.id, generation: value.generation, childPlan: value.childPlan }));
      await rpc(first.endpoint, "plan.declarations.replace", {
        contract: "trust.plan-declaration-replacement-request@1",
        plan,
        expectedRevision: previous.revision,
        declarations: previous.declarations,
        missionDeclarations: missions,
      });
      const after = await rpc<PlanView>(first.endpoint, "plan.read", { plan });
      finalRevision = after.revision;
      assert.ok(finalRevision > previous.revision);
      expectedChildren = original.length + 1;
      assert.equal(after.invocations.filter((value) => value.childPlan).length, expectedChildren);
      for (const child of original) {
        const retained = after.invocations.find((value) => value.id === child.id);
        assert.ok(retained);
        assert.equal(retained.childPlan, child.childPlan);
        assert.equal(retained.generation, child.generation);
      }
    } finally {
      await first.close();
    }
    const reopened = await startPublicRuntime("trust-retained-restarted-", {
      storage: target.storage,
      operationsDirectory: path.join(archive, "operations"),
    });
    try {
      const after = await rpc<PlanView>(reopened.endpoint, "plan.read", { plan });
      assert.equal(after.revision, finalRevision);
      assert.equal(after.invocations.filter((value) => value.childPlan).length, expectedChildren);
      for (const child of original)
        assert.equal(after.invocations.find((value) => value.id === child.id)?.childPlan, child.childPlan);
    } finally {
      await reopened.close();
    }
    console.info(`Retained import verified; private source archive preserved at ${archive}`);
  } finally {
    await target.close();
    // This archive came from retained history: preserve it for independent review.
  }
});

async function fixture(
  directory: string,
  json = '[{"name":"z","label":"é"},{"name":"a","label":"repeat"},{"name":"a","label":"repeat"}]',
) {
  const source = path.join(directory, "source.sqlite");
  const database = new DatabaseSync(source);
  initializeSqliteSchema(database);
  database.prepare("INSERT INTO environments VALUES (?, ?, ?)").run("imported", instant, instant);
  database.prepare("INSERT INTO environment_variables VALUES (?, ?, ?, ?)").run("imported", "exact", "é\r\n", instant);
  database
    .prepare("INSERT INTO source_templates VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("import-template", 0, "Imported", "exact", "Feature: source\r\n  # preserved\r\n", json, 7);
  database.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('attempts', 91)").run();
  database.close();
  const operations = path.join(directory, "operations");
  await mkdir(operations);
  await writeFile(path.join(operations, "README.txt"), "Exact Operation catalog archive\r\n");
  return { source, operations };
}

async function runImport(source: string, operations: string, archive: string, target: StorageConfiguration) {
  return execute(
    process.execPath,
    [
      command,
      "--source",
      source,
      "--operations",
      operations,
      "--archive",
      archive,
      ...(target.kind === "pglite" ? ["--pglite", target.directory] : ["--postgresql-env", "TRUST_IMPORT_TEST_TARGET"]),
    ],
    {
      env: {
        ...process.env,
        ...(target.kind === "postgresql" ? { TRUST_IMPORT_TEST_TARGET: target.connectionString } : {}),
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  );
}

async function newTarget(directory: string): Promise<{ storage: StorageConfiguration; close(): Promise<void> }> {
  const admin = process.env.TRUST_ACCEPTANCE_POSTGRES_URL;
  if (!admin) return { storage: { kind: "pglite", directory: path.join(directory, "target") }, close: async () => {} };
  const name = `trust_import_${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  } finally {
    await client.end();
  }
  const connection = new URL(admin);
  connection.pathname = `/${name}`;
  return {
    storage: { kind: "postgresql", connectionString: connection.href },
    close: async () => {
      const cleanup = new Client({ connectionString: admin });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

async function rpc<T = unknown>(endpoint: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  const result = (await response.json()) as { result?: unknown; error?: unknown };
  assert.equal(result.error, undefined);
  return result.result as T;
}
function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
