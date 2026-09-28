import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const administratorUrl =
  process.env.COORDINATION_VERIFICATION_DATABASE_URL ?? process.env.TRUST_COORDINATION_DATABASE_URL;

test("a relaunched invocation generation rebinds its identical mission request and keeps the mission state", async () => {
  assert.ok(administratorUrl, "A disposable-database administrator connection is required; this test never skips");
  const admin = new pg.Client({ connectionString: administratorUrl });
  const database = `trust_relaunch_${randomUUID().replaceAll("-", "")}`;
  let db;
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    created = true;
    const url = new URL(administratorUrl);
    url.pathname = `/${database}`;
    db = new pg.Client({ connectionString: url.href });
    await db.connect();
    await db.query(
      await readFile(path.join(root, "environments/trust-test/manifests/postgres/002-missions.sql"), "utf8"),
    );
    const create = async (request) =>
      (await db.query("SELECT trust_coordination.mission_create($1::jsonb) AS view", [request])).rows[0].view;
    const request = {
      mission: "relaunched-mission",
      plan: "child-generation-1",
      assignee: "worker",
      project: "acceptance",
      instructions: "Deliver the facet.",
      expected: "The assertions pass.",
      authorized: "Edit the facet.",
      forbidden: "Change the requirements.",
    };
    await create(request);
    await db.query("SELECT trust_coordination.mission_claim($1::jsonb)", [
      { mission: request.mission, actor: "worker" },
    ]);

    const rebound = await create({ ...request, plan: "child-generation-2" });
    assert.equal(rebound.plan, "child-generation-2", "the mission follows the new generation's Plan");
    assert.equal(rebound.state, "claimed", "the mission keeps its state");
    assert.equal(rebound.owner, "worker", "the mission keeps its owner");
    assert.deepEqual(await create({ ...request, plan: "child-generation-2" }), rebound, "a replay is idempotent");

    await assert.rejects(
      create({ ...request, plan: "child-generation-3", instructions: "Another task." }),
      /already has a different request/u,
      "any other request difference is still refused",
    );
    const events = await db.query(
      "SELECT event FROM trust_coordination.mission_events WHERE mission = $1 ORDER BY sequence",
      [request.mission],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event),
      ["created", "claimed", "relaunched"],
    );
  } finally {
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
