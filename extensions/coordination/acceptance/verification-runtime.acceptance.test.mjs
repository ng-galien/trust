import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { publicMcp } from "../../../environments/trust-test/scripts/lib/public-mcp.mjs";
import { startPublicRuntime } from "../../../packages/trust-runtime/dist/acceptance/support/runtime-process.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);
const administratorUrl =
  process.env.COORDINATION_VERIFICATION_DATABASE_URL ?? process.env.TRUST_COORDINATION_DATABASE_URL;
async function rpc(endpoint, method, params) {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  const envelope = await response.json();
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}
async function check(endpoint, plan, name) {
  const text = await publicMcp(endpoint, "trust_plan_read", { plan });
  const intent = /Current intent: (.+)/u.exec(text)?.[1];
  assert.ok(intent);
  const view = await rpc(endpoint, "plan.read", { plan });
  const selected = view.checks.find((entry) => entry.name === name || entry.check === name);
  assert.ok(selected, JSON.stringify(view.checks));
  const uri = new URL(selected.checkUri);
  uri.searchParams.set("intent", intent);
  if (name !== "observe completion") uri.searchParams.set("nextIntent", `Continue ${plan} after ${name}`);
  const env = {
    ...process.env,
    TRUST_RPC_ENDPOINT: `${endpoint}/rpc`,
    TRUST_OTLP_ENDPOINT: `${endpoint}/v1/traces`,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = await execute(
    process.execPath,
    [path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"), uri.href, "--json"],
    { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}

// These are real isolated mission transitions and real child test processes, not simulated Facts.
test("VERIFY-INTEGRATION Runner qualifications reject failed zero skipped crashed and stale groups before response", {
  timeout: 120000,
}, async (t) => {
  assert.ok(administratorUrl, "A disposable-database administrator connection is required; this test never skips");
  const admin = new pg.Client({ connectionString: administratorUrl });
  const database = `trust_verify_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(path.join(tmpdir(), "trust-verification-public-"));
  let runtime,
    db,
    created = false;
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
    const ops = path.join(directory, "operations");
    await mkdir(ops);
    for (const file of [
      "coordination.mission-create.feature",
      "coordination.mission-claim.feature",
      "coordination.mission-submit.feature",
      "coordination.mission-read.feature",
      "coordination.verification-run.feature",
    ])
      await copyFile(path.join(root, "assets/operations", file), path.join(ops, file));
    runtime = await startPublicRuntime("trust-verification-core-", { operationsDirectory: ops });
    await rpc(runtime.endpoint, "procedure.publish", {
      source: await readFile(path.join(root, "assets/procedures/agent-delegation-verified.feature"), "utf8"),
      sourceName: "agent-delegation-verified.feature",
    });
    const good = "import test from 'node:test';test('VERIFY named assertion',t=>{t.plan(1);t.assert.equal(2+2,4);});";
    for (const [variant, body] of [
      ["green", good],
      ["failed", good.replace("2+2,4", "2+2,5")],
      ["zero", 'console.log("zero");'],
      ["skipped", good.replace("test('", "test.skip('")],
      ["crashed", "process.exit(7);"],
      ["stale", good],
    ]) {
      const fixture = path.join(directory, variant);
      await mkdir(path.join(fixture, "scripts"), { recursive: true });
      await copyFile(
        path.join(root, "scripts/coordination-verification.mjs"),
        path.join(fixture, "scripts/coordination-verification.mjs"),
      );
      await writeFile(path.join(fixture, "source.js"), "export const source=4;");
      await writeFile(path.join(fixture, "artifact.js"), "export const compiled=4;");
      const roots = {
        mission: `verification-${variant}`,
        assignee: "worker",
        reviewer: "coordinator",
        project: "disposable-verification",
        instructions: "Run required tests",
        expected: "Named assertions executed",
        authorized: "Disposable fixtures only",
        forbidden: "Retained data changes",
      };
      for (const layer of ["unit", "integration", "database"]) {
        const integration =
          "import test from 'node:test';import {readFileSync} from 'node:fs';const context=JSON.parse(readFileSync(new URL('./verification-context.json',import.meta.url),'utf8'));test('VERIFY named assertion',async t=>{t.plan(2);const response=await fetch(context.endpoint+'/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'plan.read',params:{plan:context.plan}})});const payload=await response.json();t.assert.equal(response.status,200);t.assert.equal(payload.result.plan,context.plan);});";
        const databaseTest = `import test from 'node:test';import {readFileSync} from 'node:fs';import pg from ${JSON.stringify(new URL("node_modules/pg/lib/index.js", new URL("../../../", import.meta.url)).href)};const context=JSON.parse(readFileSync(new URL('./verification-context.json',import.meta.url),'utf8'));test('VERIFY named assertion',async t=>{t.plan(2);const db=new pg.Client({connectionString:context.databaseUrl});db.password=context.databasePassword;await db.connect();try{await db.query('BEGIN');await db.query('CREATE TEMP TABLE verification_rows(value integer) ON COMMIT DROP');await db.query('INSERT INTO verification_rows VALUES (42)');t.assert.equal((await db.query('SELECT value FROM verification_rows')).rows[0].value,42);await db.query('ROLLBACK');t.assert.equal((await db.query("SELECT to_regclass('verification_rows') AS relation")).rows[0].relation,null);}finally{await db.end();}});`;
        await writeFile(
          path.join(fixture, `${layer}.mjs`),
          layer === "unit" ? body : layer === "integration" ? integration : databaseTest,
        );
        roots[`${layer} verification`] = JSON.stringify({
          id: `VERIFY-${layer}`,
          layer,
          requirements: ["VERIFY"],
          testFiles: [`${layer}.mjs`],
          assertions: [{ requirement: "VERIFY", name: "VERIFY named assertion", file: `${layer}.mjs` }],
          sourcePaths: ["source.js"],
          artifactPaths: ["artifact.js"],
        });
      }
      // Environment writes are confined to this disposable runtime, never the retained coordination service.
      // The Runner never reads a database password from its process or the URL: the Environment holds a
      // password-free URL and the mission Operations authenticate with the declared Credential.
      const databaseUrl = new URL(url.href);
      const databasePassword = decodeURIComponent(databaseUrl.password) || process.env.PGPASSWORD;
      assert.ok(databasePassword, "The disposable database requires password authentication");
      databaseUrl.password = "";
      await rpc(runtime.endpoint, "environment.save", {
        environment: variant,
        values: { workspaceRoot: fixture, databaseUrl: databaseUrl.href },
      });
      await rpc(runtime.endpoint, "credential.save", {
        environment: variant,
        name: "databasePassword",
        value: databasePassword,
      });
      // The Runner gives Shell commands no caller variables, so the fixture tests read their context from a file
      // of the disposable fixture, outside the verified closure.
      await writeFile(
        path.join(fixture, "verification-context.json"),
        JSON.stringify({
          endpoint: runtime.endpoint,
          plan: roots.mission,
          databaseUrl: databaseUrl.href,
          databasePassword,
        }),
      );
      await rpc(runtime.endpoint, "plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: "agent-delegation",
        procedureVersion: "1.1.0",
        plan: roots.mission,
        environment: variant,
        rootInputs: roots,
      });
      for (const name of ["create mission", "claim mission"])
        assert.equal((await check(runtime.endpoint, roots.mission, name)).result.qualification.verdict, "VALIDATED");
      let view = await rpc(runtime.endpoint, "plan.read", { plan: roots.mission });
      await rpc(runtime.endpoint, "plan.declarations.replace", {
        contract: "trust.plan-declaration-replacement-request@1",
        plan: roots.mission,
        expectedRevision: view.revision,
        declarations: { response: "A completed response alone must not complete this mission", outcome: "completed" },
      });
      assert.equal((await check(runtime.endpoint, roots.mission, "submit response")).result.status, "REFUSED");
      const unit = await check(runtime.endpoint, roots.mission, "verify unit");
      assert.equal(unit.result.status, "COMPLETED");
      const shouldPass = variant === "green" || variant === "stale";
      assert.equal(unit.result.qualification.verdict, shouldPass ? "VALIDATED" : "NOT_VALIDATED", variant);
      if (!shouldPass) {
        assert.equal(
          (await rpc(runtime.endpoint, "plan.read", { plan: roots.mission })).checks.some(
            (entry) => entry.name === "review unit",
          ),
          false,
        );
        assert.equal((await check(runtime.endpoint, roots.mission, "submit response")).result.status, "REFUSED");
        assert.equal(
          (await db.query("SELECT state FROM trust_coordination.missions WHERE mission=$1", [roots.mission])).rows[0]
            .state,
          "claimed",
        );
        continue;
      }
      for (const name of ["verify integration", "verify database"]) {
        const verified = (await check(runtime.endpoint, roots.mission, name)).result;
        assert.equal(verified.qualification.verdict, "VALIDATED", `${name}: ${JSON.stringify(verified.qualification)}`);
      }
      if (variant === "stale") await writeFile(path.join(fixture, "artifact.js"), "changed artifact");
      const review = await check(runtime.endpoint, roots.mission, "review unit");
      assert.equal(review.result.qualification.verdict, variant === "stale" ? "NOT_VALIDATED" : "VALIDATED");
      if (variant === "stale") {
        assert.equal((await check(runtime.endpoint, roots.mission, "submit response")).result.status, "REFUSED");
        continue;
      }
      for (const name of ["review integration", "review database"])
        assert.equal((await check(runtime.endpoint, roots.mission, name)).result.qualification.verdict, "VALIDATED");
      assert.equal(
        (await check(runtime.endpoint, roots.mission, "submit response")).result.qualification.verdict,
        "VALIDATED",
      );
      view = await rpc(runtime.endpoint, "plan.read", { plan: roots.mission });
      assert.notEqual(view.workState, "COMPLETE");
      assert.equal(
        (await db.query("SELECT state,response FROM trust_coordination.missions WHERE mission=$1", [roots.mission]))
          .rows[0].state,
        "completed",
      );
      assert.equal(
        (await check(runtime.endpoint, roots.mission, "observe completion")).result.qualification.verdict,
        "VALIDATED",
      );
      assert.equal((await rpc(runtime.endpoint, "plan.read", { plan: roots.mission })).workState, "COMPLETE");
    }
    await t.test(
      "VERIFY-DATABASE only qualified groups permit persisted completion and an ordered event history",
      async () => {
        const rows = (await db.query("SELECT mission,state FROM trust_coordination.missions ORDER BY mission")).rows;
        assert.equal(rows.length, 6);
        for (const row of rows) assert.equal(row.state, row.mission === "verification-green" ? "completed" : "claimed");
        const events = (await db.query("SELECT mission,event FROM trust_coordination.mission_events ORDER BY sequence"))
          .rows;
        for (const row of rows)
          assert.deepEqual(
            events.filter((event) => event.mission === row.mission).map((event) => event.event),
            row.mission === "verification-green" ? ["created", "claimed", "completed"] : ["created", "claimed"],
          );
      },
    );
  } finally {
    await runtime?.close();
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
