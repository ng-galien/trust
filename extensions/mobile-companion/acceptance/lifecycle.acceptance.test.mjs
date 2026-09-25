import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { publicMcp } from "../../../environments/trust-test/scripts/lib/public-mcp.mjs";
import { startPublicRuntime } from "../../../packages/trust-runtime/dist/acceptance/support/runtime-process.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);
const form = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      decision: { type: "string", title: "Decision", enum: ["Approve", "Revise"] },
      context: { type: "string", title: "Context", format: "textarea", maxLength: 8000 },
      urgent: { type: "boolean", title: "Urgent" },
      score: { type: "number", title: "Priority score", minimum: 0, maximum: 10 },
    },
    required: ["decision", "urgent"],
  },
  uiSchema: {
    type: "VerticalLayout",
    elements: [
      { type: "Control", scope: "#/properties/decision" },
      { type: "Control", scope: "#/properties/context" },
      { type: "Control", scope: "#/properties/urgent" },
      { type: "Control", scope: "#/properties/score" },
    ],
  },
};

test("mobile extension persists a schema-driven answer through the public host and exposes it to agents and HTTP Operations", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-mobile-companion-"));
  const data = path.join(directory, "pglite");
  const operationsDirectory = path.join(directory, "operations");
  await mkdir(operationsDirectory);
  const installations = path.join(directory, "extensions.json");
  await writeFile(
    installations,
    JSON.stringify({
      extensions: [
        {
          manifest: path.join(root, "extensions/mobile-companion/extension.json"),
          configuration: { databasePath: data },
          environment: "local",
          grants: ["plans.read", "plans.subscribe"],
          autoStart: false,
        },
      ],
    }),
  );
  const runtime = await startPublicRuntime("trust-mobile-runtime-", {
    extensionsFile: installations,
    operationsDirectory,
  });
  const endpoint = `${runtime.endpoint}/extensions/mobile-companion`;
  const transition = (action) =>
    fetch(`${endpoint}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const command = (name, args) =>
    fetch(`${endpoint}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: name, arguments: args }),
    });
  const mcp = (name, args) =>
    publicMcp(runtime.endpoint, "trust_extension_mobile_companion", { command: name, arguments: args });
  const rpc = async (method, params) => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
    const envelope = await response.json();
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const item = {
    id: "trust-plan-choice-1",
    project: "trust",
    kind: "decision",
    title: "Approve the next step",
    summary: "Choose whether to approve or revise.",
    body: "Read the proposed change and choose one option.",
    plan: "mobile-response-parent",
    form,
  };
  const eventControllers = [new AbortController(), new AbortController()];
  const eventReaders = [];
  const waitChange = async (reader) => {
    let received = "";
    while (!received.includes('"type":"extension.changed"')) {
      const next = await reader.read();
      assert.equal(next.done, false, "extension SSE closed before change");
      received += new TextDecoder().decode(next.value);
    }
  };
  try {
    assert.equal((await transition("start")).status, 502, "start does not create storage");
    assert.equal((await transition("prepare")).status, 200);
    assert.equal((await transition("prepare")).status, 200, "compatible preparation is repeat-safe");
    assert.equal((await transition("start")).status, 200);
    for (const controller of eventControllers) {
      const response = await fetch(`${endpoint}/events`, { signal: controller.signal });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      eventReaders.push(response.body.getReader());
    }
    assert.equal((await transition("prepare")).status, 409, "running preparation is refused");
    const catalog = await (await fetch(`${runtime.endpoint}/extensions`)).json();
    assert.equal(catalog.extensions[0].state, "RUNNING");
    assert.ok(!JSON.stringify(catalog).includes(data), "storage path stays out of the public catalog");
    const project = JSON.parse(
      await mcp("projects.put", { id: "trust", title: "TRUST", status: "active", route: "/mobile/mobile-companion" }),
    );
    assert.equal(project.id, "trust");
    await Promise.all(eventReaders.map(waitChange));
    assert.equal(
      (
        await command("projects.put", {
          id: "outside",
          title: "Outside",
          status: "active",
          route: "https://example.invalid",
        })
      ).status,
      400,
      "catalog routes stay on the private mobile origin",
    );
    assert.equal((await command("feed.publish", item)).status, 201);
    await Promise.all(eventReaders.map(waitChange));
    const dataSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        heading: { type: "string", minLength: 1 },
        points: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        featured: { type: "boolean" },
      },
      required: ["heading", "points", "featured"],
    };
    const template = {
      id: "summary",
      version: 1,
      title: "Summary",
      source:
        "# {{ data.heading }}\n{% if data.featured %}**Featured**{% endif %}\n{% for point in data.points %}- {{ point }}\n{% endfor %}",
      dataSchema,
    };
    assert.equal(JSON.parse(await mcp("templates.put", template)).version, 1);
    assert.deepEqual(JSON.parse(await mcp("templates.read", { id: "summary", version: 1 })).dataSchema, dataSchema);
    assert.equal(JSON.parse(await mcp("templates.list", {})).templates[0].id, "summary");
    assert.equal((await command("templates.put", { ...template, title: "Changed" })).status, 409);
    const structured = {
      id: "structured-summary-1",
      project: "trust",
      kind: "explanation",
      title: "Structured summary",
      summary: "A reusable Markdown post.",
      templateId: "summary",
      templateVersion: 1,
      data: { heading: "Status", points: ["First", "<script>unsafe</script>"], featured: true },
      supersedes: item.id,
    };
    const published = JSON.parse(await mcp("posts.publish", structured));
    assert.equal(published.source.mode, "template");
    assert.equal(published.supersedes, item.id);
    assert.match(published.body, /# Status/);
    assert.match(published.body, /- First/);
    assert.ok(!published.body.includes("<script>"), "dynamic data is escaped in the Markdown snapshot");
    await Promise.all(eventReaders.map(waitChange));
    assert.deepEqual(JSON.parse(await mcp("posts.read", { item: structured.id })), published);
    assert.equal((await command("posts.publish", structured)).status, 200);
    assert.equal((await command("posts.publish", { ...structured, id: "incomplete-post", data: {} })).status, 400);
    assert.equal((await command("posts.publish", { ...structured, id: "mixed-post", body: "raw" })).status, 400);
    assert.equal(
      (await command("posts.publish", { ...structured, id: "wrong-post", data: { ...structured.data, extra: true } }))
        .status,
      400,
    );
    assert.equal(JSON.parse(await mcp("items.read", { item: item.id })).source.mode, "raw");
    const revisionTemplate = {
      ...template,
      version: 2,
      source: "## {{ data.heading }}\n{% for point in data.points %}- {{ point }}\n{% endfor %}",
    };
    assert.equal(JSON.parse(await mcp("templates.put", revisionTemplate)).version, 2);
    const revised = JSON.parse(
      await mcp("posts.publish", {
        ...structured,
        id: "structured-summary-2",
        templateVersion: 2,
        supersedes: structured.id,
      }),
    );
    assert.match(revised.body, /^## Status/);
    await Promise.all(eventReaders.map(waitChange));
    assert.notEqual(
      (await command("posts.publish", { ...structured, id: "branch-post", supersedes: structured.id })).status,
      201,
    );
    assert.equal(
      (await (await fetch(`${endpoint}/api/items/${structured.id}`)).json()).body,
      published.body,
      "the first rendered snapshot stays frozen after publishing another template version",
    );
    assert.equal((await command("feed.publish", item)).status, 200, "identical publish retry is safe");
    assert.equal((await command("feed.publish", { ...item, title: "Different title" })).status, 409);
    assert.equal(
      (
        await command("feed.publish", {
          ...item,
          form: {
            ...form,
            schema: {
              ...form.schema,
              properties: {
                ...form.schema.properties,
                decision: {
                  ...form.schema.properties.decision,
                  title: "A changed choice",
                },
              },
            },
          },
        })
      ).status,
      409,
      "an existing form cannot silently change",
    );
    const feed = await (await fetch(`${endpoint}/api/feed?project=trust`)).json();
    assert.equal(feed.items[0].id, "structured-summary-2");
    assert.equal(feed.items.find((entry) => entry.id === item.id).hasForm, true);
    const detail = await (await fetch(`${endpoint}/api/items/${item.id}`)).json();
    assert.deepEqual(detail.form.schema, form.schema);
    assert.deepEqual(detail.form.uiSchema, form.uiSchema);
    assert.equal((await fetch(`${endpoint}/api/responses/${item.id}`)).status, 404);
    assert.equal(
      (
        await command("responses.submit", {
          item: item.id,
          expectedRevision: 0,
          answers: { decision: "Other", urgent: true },
        })
      ).status,
      400,
    );
    assert.equal(
      (await command("responses.submit", { item: item.id, expectedRevision: 0, answers: { decision: "Approve" } }))
        .status,
      400,
      "required fields are checked on the server",
    );
    assert.equal(
      (
        await command("responses.submit", {
          item: item.id,
          expectedRevision: 0,
          answers: { decision: "Approve", urgent: false, score: 11 },
        })
      ).status,
      400,
    );
    const answers = { decision: "Approve", context: "Proceed after review.", urgent: false, score: 7.5 };
    assert.equal((await command("responses.submit", { item: item.id, expectedRevision: 0, answers })).status, 201);
    await Promise.all(eventReaders.map(waitChange));
    assert.equal((await command("responses.submit", { item: item.id, expectedRevision: 0, answers })).status, 200);
    assert.equal(
      (
        await command("responses.submit", {
          item: item.id,
          expectedRevision: 0,
          answers: { ...answers, decision: "Revise" },
        })
      ).status,
      409,
    );
    assert.equal((await command("responses.submit", { item: item.id, expectedRevision: 1, answers })).status, 409);
    const operationRead = await (await fetch(`${endpoint}/api/responses/${item.id}`)).json();
    assert.deepEqual(operationRead.answers, answers);
    assert.equal(operationRead.item, item.id);
    assert.equal(operationRead.formRevision, 1);
    assert.equal(operationRead.responseRevision, 1);
    const agentRead = JSON.parse(await mcp("responses.read", { item: item.id }));
    assert.deepEqual(agentRead, operationRead, "MCP and HTTP expose the same durable response");
    await rpc("environment.save", {
      environment: "local",
      values: { mobileResponseUrl: `${endpoint}/api/responses/` },
    });
    await rpc("operation.save", {
      source: await readFile(
        path.join(root, "extensions/mobile-companion/operations/mobile.response-decision-read.feature"),
        "utf8",
      ),
      sourceName: "mobile.response-decision-read.feature",
    });
    await rpc("procedure.publish", {
      source: `# language: en
@trust-dsl:1 @procedure:mobile-response-acceptance @version:1.0.0
Feature: Read a mobile decision through a governed Check

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the submitted mobile response. | Change the mobile response. |
    Given one reference "form"

  @scenario:read-response
  Scenario: Observe the submitted response
    Then Check "read response" runs Operation "mobile.response-decision-read@1.0.0" on "form" as Input "item" and must establish "the response approves the next step"
      """js
      fact.decision === "Approve" || fail("the response did not approve the next step")
      """
`,
      sourceName: "mobile-response-acceptance.feature",
    });
    await rpc("procedure.publish", {
      source: `# language: en
@trust-dsl:1 @procedure:mobile-response-parent @version:1.0.0
Feature: Verify a delegated mobile decision

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the submitted mobile response. | Change the mobile response. |
    And one reference "form"

  @scenario:decision
  Scenario: Qualify the delegated decision
    Then Invocation "verify decision" runs Procedure "mobile-response-acceptance@1.0.0" on "form" as Input "form" and must establish "the child response Check is validated"
`,
      sourceName: "mobile-response-parent.feature",
    });
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "mobile-response-acceptance",
      procedureVersion: "1.0.0",
      plan: "mobile-response-plan",
      environment: "local",
      rootInputs: { form: item.id },
    });
    const plan = await rpc("plan.read", { plan: "mobile-response-plan" });
    const check = plan.checks.find((entry) => entry.operation === "mobile.response-decision-read");
    assert.ok(check?.actionable);
    const run = await execute(
      process.execPath,
      [path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"), check.checkUri, "--json"],
      {
        env: {
          ...process.env,
          TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
          TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
        },
        timeout: 30000,
      },
    );
    const verdict = JSON.parse(run.stdout);
    assert.equal(verdict.result.status, "COMPLETED", JSON.stringify(verdict));
    assert.equal(verdict.result.qualification.verdict, "VALIDATED");
    assert.equal((await rpc("plan.read", { plan: "mobile-response-plan" })).workState, "COMPLETE");
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "mobile-response-parent",
      procedureVersion: "1.0.0",
      plan: "mobile-response-parent",
      environment: "local",
      rootInputs: { form: item.id },
    });
    const parent = await rpc("plan.read", { plan: "mobile-response-parent" });
    assert.equal(parent.invocations.length, 1);
    const childPlan = parent.invocations[0].childPlan;
    assert.ok(childPlan);
    const child = await rpc("plan.read", { plan: childPlan });
    const childRun = await execute(
      process.execPath,
      [path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"), child.checks[0].checkUri, "--json"],
      {
        env: {
          ...process.env,
          TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
          TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
        },
        timeout: 30000,
      },
    );
    assert.equal(JSON.parse(childRun.stdout).result.qualification.verdict, "VALIDATED");
    assert.equal((await rpc("plan.read", { plan: "mobile-response-parent" })).workState, "COMPLETE");
    const episodeResponse = await fetch(`${endpoint}/trust/episodes/mobile-response-parent`);
    assert.equal(episodeResponse.status, 200);
    const episode = await episodeResponse.json();
    assert.equal(episode.contract, "trust.delegation-episode@1");
    assert.equal(episode.root.plan.plan, "mobile-response-parent");
    assert.equal(episode.root.plan.workState, "COMPLETE");
    assert.equal(episode.branches.length, 1);
    assert.equal(episode.branches[0].invocation.state, "SATISFIED");
    assert.equal(episode.branches[0].child.plan.plan, childPlan);
    assert.equal(episode.branches[0].child.checks[0].latestVerdict, "VALIDATED");
    assert.equal(episode.branches[0].child.checks[0].attempts[0].facts[0].values.decision, "Approve");
    await rpc("environment.save", {
      environment: "private",
      values: { mobileResponseUrl: `${endpoint}/api/responses/` },
    });
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "mobile-response-parent",
      procedureVersion: "1.0.0",
      plan: "private-response-plan",
      environment: "private",
      rootInputs: { form: item.id },
    });
    assert.equal((await fetch(`${endpoint}/trust/episodes/private-response-plan`)).status, 404);
    await command("feed.publish", {
      ...item,
      id: "unanswered-form-2",
      form: {
        schema: {
          type: "object",
          properties: { next: { type: "string", title: "Next step", enum: ["A", "B"] } },
          required: ["next"],
          additionalProperties: false,
        },
      },
    });
    eventControllers.forEach((controller) => {
      controller.abort();
    });
    assert.equal((await transition("stop")).status, 200);
    assert.equal((await transition("start")).status, 200);
    assert.deepEqual(
      await (await fetch(`${endpoint}/api/responses/${item.id}`)).json(),
      operationRead,
      "answer survives extension restart",
    );
    assert.equal((await transition("stop")).status, 200);
  } finally {
    eventControllers.forEach((controller) => {
      controller.abort();
    });
    await runtime.close();
  }
  const database = await PGlite.create(data);
  try {
    const rows = (
      await database.query(`SELECT id,body,template_id,template_version,data,rendered_markdown
      FROM trust_mobile_companion.items WHERE id IN ('trust-plan-choice-1','structured-summary-1') ORDER BY id`)
    ).rows;
    assert.equal(rows.find((row) => row.id === item.id).body, item.body);
    assert.equal(rows.find((row) => row.id === item.id).template_id, null);
    assert.equal(rows.find((row) => row.id === "structured-summary-1").body, null);
    assert.equal(rows.find((row) => row.id === "structured-summary-1").template_id, "summary");
    assert.ok(rows.find((row) => row.id === "structured-summary-1").rendered_markdown);
    const invalidPost = (id, body, templateId, templateVersion, dataValue) =>
      database.query(
        `INSERT INTO trust_mobile_companion.items
      (id,project,kind,title,summary,body,template_id,template_version,data,rendered_markdown,rendered_sha256,renderer)
      VALUES($1,'trust','explanation','Invalid','Invalid',$2,$3,$4,$5::jsonb,'Snapshot',$6,'liquidjs@10.29.0')`,
        [id, body, templateId, templateVersion, dataValue === null ? null : JSON.stringify(dataValue), "a".repeat(64)],
      );
    await assert.rejects(invalidPost("bad-mixed", "Raw", "summary", 1, {}), /check constraint/i);
    await assert.rejects(invalidPost("bad-neither", null, null, null, null), /check constraint/i);
    await assert.rejects(invalidPost("bad-no-data", null, "summary", 1, null), /check constraint/i);
    await assert.rejects(invalidPost("bad-no-template", null, null, null, {}), /check constraint/i);
    await assert.rejects(invalidPost("bad-fk", null, "absent", 1, {}), /foreign key constraint/i);
    await assert.rejects(
      database.query(`INSERT INTO trust_mobile_companion.projects
      (id,title,description,status) VALUES('invalid','Invalid','','other')`),
      /check constraint/i,
    );
    await assert.rejects(
      database.query(`INSERT INTO trust_mobile_companion.items
      (id,project,kind,title,summary,body) VALUES('bad-document','trust','document','Bad','Bad','Bad')`),
      /check constraint/i,
    );
    await assert.rejects(
      database.transaction(async (tx) => {
        await tx.query("INSERT INTO trust_mobile_companion.responses(item) VALUES('unanswered-form-2')");
      }),
      /Required response value is absent/,
    );
    assert.equal(
      (await database.query("SELECT count(*)::integer AS count FROM trust_mobile_companion.responses")).rows[0].count,
      1,
    );
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mobile feed publication delivers a signed, payload-free Web Push through the public runtime", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-mobile-push-"));
  const data = path.join(directory, "pglite");
  const pushes = [];
  let pushStatus = 201;
  const service = createServer((request, response) => {
    pushes.push({ method: request.method, url: request.url, headers: request.headers });
    response.writeHead(pushStatus).end();
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  const address = service.address();
  assert.ok(address && typeof address !== "string");
  const pushOrigin = `http://127.0.0.1:${address.port}`;
  const installations = path.join(directory, "extensions.json");
  await writeFile(
    installations,
    JSON.stringify({
      extensions: [
        {
          manifest: path.join(root, "extensions/mobile-companion/extension.json"),
          configuration: {
            databasePath: data,
            pushSubject: "mailto:mobile@example.com",
            pushAllowedOrigins: pushOrigin,
          },
          environment: "local",
          grants: ["plans.read", "plans.subscribe"],
          autoStart: false,
        },
      ],
    }),
  );
  const runtime = await startPublicRuntime("trust-mobile-push-runtime-", { extensionsFile: installations });
  const base = `${runtime.endpoint}/extensions/mobile-companion`;
  const transition = (action) =>
    fetch(`${base}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const command = (name, args) =>
    fetch(`${base}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: name, arguments: args }),
    });
  const until = async (predicate) => {
    const deadline = Date.now() + 30000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error("Push delivery timed out");
      await delay(50);
    }
  };
  try {
    assert.equal((await transition("prepare")).status, 200);
    assert.equal((await transition("start")).status, 200);
    const publicStatus = await (await fetch(`${base}/api/notifications/status`)).json();
    assert.equal(publicStatus.enabled, true);
    assert.equal(Buffer.from(publicStatus.publicKey, "base64url").length, 65);
    assert.ok(!JSON.stringify(publicStatus).includes("private_key"));
    assert.equal((await command("notifications.subscribe", { endpoint: "https://example.invalid/push" })).status, 400);
    const endpoint = `${pushOrigin}/push/phone`;
    assert.equal((await command("notifications.subscribe", { endpoint })).status, 200);
    assert.equal((await transition("stop")).status, 200);
    assert.equal((await transition("start")).status, 200);
    assert.equal((await command("projects.put", { id: "trust", title: "TRUST", status: "active" })).status, 200);
    const item = {
      project: "trust",
      kind: "progress",
      title: "New update",
      summary: "A new update",
      body: "Read the update.",
    };
    assert.equal((await command("feed.publish", { ...item, id: "push-first" })).status, 201);
    await until(() => pushes.length === 1);
    const sent = pushes[0];
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/push/phone");
    assert.equal(sent.headers.ttl, "86400");
    assert.equal(sent.headers["content-length"], "0");
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(sent.headers.authorization);
    assert.ok(match, "VAPID authorization is present");
    assert.equal(match[4], publicStatus.publicKey);
    const claims = JSON.parse(Buffer.from(match[2], "base64url").toString());
    assert.equal(claims.aud, pushOrigin);
    assert.equal(claims.sub, "mailto:mobile@example.com");
    assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);
    const point = Buffer.from(publicStatus.publicKey, "base64url");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    assert.equal(
      verify(
        "sha256",
        Buffer.from(`${match[1]}.${match[2]}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(match[3], "base64url"),
      ),
      true,
    );
    pushStatus = 503;
    assert.equal((await command("feed.publish", { ...item, id: "push-retry" })).status, 201);
    await until(() => pushes.length === 2);
    pushStatus = 201;
    await until(() => pushes.length === 3);
    pushStatus = 410;
    assert.equal((await command("feed.publish", { ...item, id: "push-expired" })).status, 201);
    await until(() => pushes.length === 4);
    await until(async () => (await (await fetch(`${base}/api/notifications/status`)).json()).pending === 0);
    assert.equal((await transition("stop")).status, 200);
  } finally {
    await runtime.close();
    await new Promise((resolve) => service.close(resolve));
  }
  const database = await PGlite.create(data);
  try {
    assert.deepEqual(
      (await database.query("SELECT item,state,last_status FROM trust_mobile_companion.push_deliveries ORDER BY item"))
        .rows,
      [
        { item: "push-expired", state: "cancelled", last_status: 410 },
        { item: "push-first", state: "delivered", last_status: 201 },
        { item: "push-retry", state: "delivered", last_status: 201 },
      ],
    );
    assert.equal(
      (await database.query("SELECT attempts FROM trust_mobile_companion.push_deliveries WHERE item='push-retry'"))
        .rows[0].attempts,
      2,
    );
    assert.equal(
      (await database.query("SELECT active FROM trust_mobile_companion.push_subscriptions")).rows[0].active,
      false,
    );
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
