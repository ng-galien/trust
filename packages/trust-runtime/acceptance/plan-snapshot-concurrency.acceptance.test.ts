import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PlanView } from "@trust/extension-sdk";
import { Client } from "pg";
import { test } from "./support/fixtures.js";
import { repositoryRoot, startPublicRuntime } from "./support/runtime-process.js";

const postgresAvailable = Boolean(process.env.TRUST_ACCEPTANCE_POSTGRES_URL);

test("a suspended Plan reader does not block a writer and returns one committed snapshot", {
  skip: !postgresAvailable,
}, async () => {
  await withPostgresRuntime(async ({ endpoint, barrier, observer }) => {
    await engage(endpoint, "snapshot-reader");
    // Pause the real RPC after its early Session read and before its final Session history read.
    // This lock belongs only to this disposable acceptance database, not to a retained runtime.
    await barrier.query("BEGIN");
    await barrier.query("LOCK TABLE attempts IN ACCESS EXCLUSIVE MODE");
    const reading = rpc<PlanView>(endpoint, "plan.read", { plan: "snapshot-reader" });
    try {
      await waitForBlockedReader(observer);
      const closed = await rpc<{ closed: boolean }>(endpoint, "plan.close", { plan: "snapshot-reader" }, 3_000);
      assert.equal(closed.closed, true, "the writer must finish while the reader is still suspended");
    } finally {
      await barrier.query("ROLLBACK");
    }
    const before = await reading;
    assert.equal(before.sessionState, "OPEN");
    assert.equal(before.sessions.filter((session) => session.state === "open").length, 1);
    const after = await rpc<PlanView>(endpoint, "plan.read", { plan: "snapshot-reader" });
    assert.equal(after.sessionState, "UNAVAILABLE");
    assert.equal(after.sessions.filter((session) => session.state === "open").length, 0);
  });
});

test("Plan reads and lists do not wait for a composition writer's advisory lock", {
  skip: !postgresAvailable,
}, async () => {
  await withPostgresRuntime(async ({ endpoint, barrier }) => {
    await engage(endpoint, "snapshot-writer");
    await barrier.query("BEGIN");
    await barrier.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["trust.plan:snapshot-writer"]);
    try {
      const view = await rpc<PlanView>(endpoint, "plan.read", { plan: "snapshot-writer" }, 3_000);
      assert.equal(view.plan, "snapshot-writer");
      const list = await rpc<{ plans: Array<{ plan: string }> }>(endpoint, "plan.list", {}, 3_000);
      assert.ok(list.plans.some((plan) => plan.plan === "snapshot-writer"));
    } finally {
      await barrier.query("ROLLBACK");
    }
  });
});

async function engage(endpoint: string, plan: string): Promise<void> {
  const source = await readFile(path.join(repositoryRoot, "assets/procedures/00-git-status.feature"), "utf8");
  await rpc(endpoint, "procedure.publish", { source, sourceName: "git-status.feature" });
  await rpc(endpoint, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan,
    environment: "local",
    mode: "dry-run",
    rootInputs: { repository: "repository" },
  });
}

async function waitForBlockedReader(observer: Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await observer.query<{ blocked: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'trust-runtime'
          AND wait_event_type = 'Lock' AND query LIKE '%"attempts"%'
      ) AS blocked`,
    );
    if (blocked.rows[0]?.blocked) return;
    await delay(20);
  }
  assert.fail("the Plan RPC did not reach the controlled database barrier");
}

async function withPostgresRuntime(
  run: (input: { endpoint: string; barrier: Client; observer: Client }) => Promise<void>,
): Promise<void> {
  const adminUrl = process.env.TRUST_ACCEPTANCE_POSTGRES_URL;
  assert.ok(adminUrl);
  const admin = new Client({ connectionString: adminUrl });
  const name = `trust_snapshot_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const barrier = new Client({ connectionString: target.href });
  const observer = new Client({ connectionString: target.href });
  let runtime: Awaited<ReturnType<typeof startPublicRuntime>> | undefined;
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  try {
    runtime = await startPublicRuntime("trust-snapshot-", {
      storage: { kind: "postgresql", connectionString: target.href },
      operationsDirectory: path.join(repositoryRoot, "assets/operations"),
      environments: { local: {} },
    });
    await barrier.connect();
    await observer.connect();
    await run({ endpoint: runtime.endpoint, barrier, observer });
  } finally {
    await barrier.end();
    await observer.end();
    await runtime?.close();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

async function rpc<T = unknown>(endpoint: string, method: string, params: unknown, timeout = 15_000): Promise<T> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(timeout),
  });
  assert.equal(response.status, 200);
  const envelope = (await response.json()) as { result: T; error?: unknown };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}
