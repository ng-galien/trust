import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { publicMcp } from "./lib/public-mcp.mjs";
import { publicRpc } from "./lib/public-rpc.mjs";

const endpoint = process.env.TRUST_URL ?? "http://127.0.0.1:4318";
const runner = fileURLToPath(
  new URL("../../../packages/trust-runner/dist/skill/trust/scripts/run.js", import.meta.url),
);
const execute = promisify(execFile);
const enabled = Boolean(process.env.TRUST_COORDINATION_DATABASE_URL);
const read = (plan) => publicRpc(endpoint, "plan.read", { plan });
async function invoke(view, name, nextIntent) {
  const check = view.checks.find((item) => item.name === name);
  assert.ok(check, `Missing Check: ${name}`);
  const uri = new URL(check.checkUri);
  uri.searchParams.set("intent", view.currentIntent);
  if (nextIntent) uri.searchParams.set("nextIntent", nextIntent);
  const { stdout } = await execute(process.execPath, [runner, uri.href, "--json"], {
    env: { ...process.env, TRUST_RPC_ENDPOINT: `${endpoint}/rpc`, TRUST_OTLP_ENDPOINT: `${endpoint}/v1/traces` },
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

for (const outcome of ["completed", "blocked"]) {
  test(`Delegation through MCP, runner, OTLP and PostgreSQL: ${outcome}`, { skip: !enabled }, async () => {
    const plan = `delegation-acceptance-${randomUUID()}`;
    const inputs = {
      mission: plan,
      assignee: "acceptance-agent",
      project: "trust",
      instructions: "Return the acceptance response.",
      expected: "A persisted response",
      authorized: "Acceptance only",
      forbidden: "No project changes",
    };
    await publicMcp(endpoint, "trust_plan_engage", {
      procedure: "agent-delegation",
      procedureVersion: "1.0.0",
      plan,
      environment: "coordination",
      metadata: { title: `Delegation acceptance: ${outcome}`, labels: ["acceptance"] },
      rootInputs: inputs,
    });
    let view = await read(plan);
    // Admission must refuse the claim before creation, without touching PostgreSQL.
    const refused = await invoke(view, "claim mission", "Submit the response");
    assert.equal(refused.result.status, "REFUSED");
    const db = new pg.Client({ connectionString: process.env.TRUST_COORDINATION_DATABASE_URL });
    await db.connect();
    try {
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM trust_coordination.missions WHERE mission=$1", [plan])).rows[0]
          .n,
        0,
      );
      const created = await invoke(view, "create mission", "Claim the persisted mission");
      assert.equal(created.result.qualification.verdict, "VALIDATED");
      view = await read(plan);
      assert.equal(
        (await invoke(view, "claim mission", "Submit the agent response")).result.qualification.verdict,
        "VALIDATED",
      );
      view = await read(plan);
      const declarations = { response: `Acceptance response: ${outcome}`, outcome };
      await publicMcp(endpoint, "trust_plan_declarations_replace", {
        plan,
        expectedRevision: view.revision,
        declarations,
      });
      const current = await read(plan);
      await assert.rejects(
        publicMcp(endpoint, "trust_plan_declarations_replace", {
          plan,
          expectedRevision: view.revision,
          declarations: { ...declarations, response: "Stale update" },
        }),
        /changed|revision|conflict/i,
      );
      assert.equal(current.satisfiedChecks, 2, "Response declarations retain creation and ownership qualification");
      assert.equal(
        (await invoke(current, "submit response", "Observe the persisted completion")).result.qualification.verdict,
        "VALIDATED",
      );
      view = await read(plan);
      const observed = await invoke(view, "observe completion");
      assert.equal(observed.result.qualification.verdict, outcome === "completed" ? "VALIDATED" : "NOT_VALIDATED");
      if (outcome === "blocked") {
        await publicMcp(endpoint, "trust_check_escalate", {
          checkUri: observed.checkUri,
          attemptHandle: observed.result.attemptHandle,
          blockingReason: "The assigned agent reported a blocker.",
          forbiddenFurtherAction: "Do not expand the mission scope to force completion.",
        });
      }
      assert.equal((await read(plan)).workState, outcome === "completed" ? "COMPLETE" : "ESCALATED");
      const stored = (await db.query("SELECT * FROM trust_coordination.missions WHERE mission=$1", [plan])).rows[0];
      assert.equal(stored.owner, inputs.assignee);
      assert.equal(stored.response, declarations.response);
      assert.equal(stored.state, outcome);
      // External business API replay and ownership invariants; no direct table writes.
      await db.query("SELECT trust_coordination.mission_create($1::jsonb)", [{ ...inputs, plan }]);
      await db.query("SELECT trust_coordination.mission_submit($1::jsonb)", [
        { mission: plan, actor: inputs.assignee, ...declarations },
      ]);
      await assert.rejects(
        db.query("SELECT trust_coordination.mission_claim($1::jsonb)", [{ mission: plan, actor: "another-agent" }]),
        /assigned agent/,
      );
      await assert.rejects(
        db.query("SELECT trust_coordination.mission_submit($1::jsonb)", [
          { mission: plan, actor: inputs.assignee, ...declarations, response: "Replacement" },
        ]),
        /immutable/,
      );
      assert.deepEqual(
        (
          await db.query("SELECT event FROM trust_coordination.mission_events WHERE mission=$1 ORDER BY sequence", [
            plan,
          ])
        ).rows.map((row) => row.event),
        ["created", "claimed", outcome],
      );
      console.log(`Retained acceptance Plan: ${plan}`);
    } finally {
      await db.end();
    }
  });
}
