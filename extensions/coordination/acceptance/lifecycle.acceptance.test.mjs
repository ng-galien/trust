import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const databaseUrl = process.env.TRUST_COORDINATION_DATABASE_URL;

test("real coordination extension prepares explicitly, observes external changes and preserves data across stop", {
  skip: !databaseUrl,
  timeout: 60000,
}, async () => {
  const admin = new pg.Client({ connectionString: databaseUrl });
  const database = `trust_ext_acceptance_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "trust-coordination-extension-"));
  let runtime;
  let db;
  let eventsAbort;
  let created = false;
  await admin.connect();
  try {
    // The generated identifier contains only a constant prefix and hexadecimal characters.
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.pathname = `/${database}`;
    db = new pg.Client({ connectionString: isolatedUrl.href });
    await db.connect();
    // Credentials travel only in the child environment, never in browser-readable configuration.
    const password = decodeURIComponent(isolatedUrl.password) || process.env.PGPASSWORD;
    isolatedUrl.password = "";
    const config = join(directory, "extensions.json");
    await writeFile(
      config,
      JSON.stringify({
        extensions: [
          {
            manifest: join(root, "extensions/coordination/extension.json"),
            configuration: { databaseUrl: isolatedUrl.href },
            environment: "coordination",
            grants: ["plans.read", "plans.subscribe"],
            credentialEnvironment: ["PGPASSWORD"],
            autoStart: false,
          },
        ],
      }),
    );
    runtime = spawn(process.execPath, [join(root, "packages/trust-runtime/dist/src/index.js")], {
      env: {
        ...process.env,
        ...(password ? { PGPASSWORD: password } : {}),
        TRUST_PORT: "0",
        TRUST_HOST: "127.0.0.1",
        TRUST_STORAGE: "pglite",
        TRUST_PGLITE_DIRECTORY: join(directory, "runtime-pglite"),
        TRUST_EXTENSIONS_FILE: config,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Runtime did not listen")), 10000);
      let output = "";
      runtime.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/TRUST runtime listening on 127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      runtime.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Runtime exited before listening"));
      });
      runtime.stderr.resume();
    });
    const lifecycle = (hook) =>
      fetch(`${endpoint}/extensions/coordination/${hook}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    const catalog = async () => (await (await fetch(`${endpoint}/extensions`)).json()).extensions[0];
    assert.equal((await catalog()).state, "STOPPED");
    assert.equal((await lifecycle("start")).ok, false, "start must not create the schema");
    assert.equal((await db.query("SELECT to_regnamespace('trust_coordination') AS schema")).rows[0].schema, null);
    assert.equal((await lifecycle("prepare")).ok, true);
    assert.equal((await lifecycle("prepare")).ok, true, "compatible preparation is repeat-safe");
    assert.deepEqual(
      (
        await db.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='trust_coordination' ORDER BY table_name",
        )
      ).rows.map((row) => row.table_name),
      ["mission_events", "missions", "tags"],
    );
    assert.equal(
      (await db.query("SELECT to_regnamespace('trust_coordination_classification') AS schema")).rows[0].schema,
      null,
    );
    assert.equal((await lifecycle("start")).ok, true);
    assert.equal((await lifecycle("start")).ok, true, "duplicate start is repeat-safe");
    assert.equal((await lifecycle("prepare")).ok, false, "running preparation is refused");
    const descriptor = await catalog();
    assert.equal(descriptor.state, "RUNNING");
    assert.ok(descriptor.ui.entry.endsWith("remoteEntry.js"));
    assert.ok(!JSON.stringify(descriptor).includes(isolatedUrl.href));

    eventsAbort = new AbortController();
    const stream = await fetch(`${endpoint}/extensions/coordination/events`, { signal: eventsAbort.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    let eventText = "";
    const collecting = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          eventText += new TextDecoder().decode(value);
        }
      } catch (error) {
        if (!eventsAbort.signal.aborted) throw error;
      }
    })();
    const mission = {
      mission: "extension-observation",
      plan: "external-plan",
      project: "acceptance",
      assignee: "acceptance-agent",
      instructions: "# Mission\n\nRead **actual** data.\n\n```mermaid\ngraph LR\nA-->B\n```",
      expected: "A preserved response",
      authorized: "Read only",
      forbidden: "No unrelated changes",
    };
    // Exercise the external business API, not direct table writes or fabricated TRUST Facts.
    await db.query("SELECT trust_coordination.mission_create($1::jsonb)", [mission]);
    const until = Date.now() + 8000;
    while (!eventText.includes("extension.changed") && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(eventText, /extension.changed/, "external mission changes reach the host SSE stream");
    const response = await fetch(`${endpoint}/extensions/coordination/api/missions?limit=1`);
    assert.equal(response.status, 200);
    const row = (await response.json()).missions[0];
    assert.equal(row.mission, mission.mission);
    assert.equal(row.request.instructions, mission.instructions);
    assert.equal(row.response, "");
    assert.equal(row.state, "pending");
    assert.deepEqual(row.tags, []);
    assert.equal(row.tagRevision, 0);
    const command = (name, args) =>
      fetch(`${endpoint}/extensions/coordination/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: name, arguments: args }),
      });
    const tagged = await command("tags.replace", {
      mission: mission.mission,
      expectedRevision: 0,
      tags: ["project:trust", "readability"],
    });
    assert.equal(tagged.status, 200);
    assert.deepEqual(await tagged.json(), {
      mission: mission.mission,
      tags: ["project:trust", "readability"],
      tagRevision: 1,
    });
    assert.equal(
      (await command("tags.replace", { mission: mission.mission, expectedRevision: 0, tags: ["stale"] })).status,
      409,
    );
    assert.equal(
      (
        await command("tags.replace", {
          mission: mission.mission,
          expectedRevision: 1,
          tags: ["duplicate", "duplicate"],
        })
      ).status,
      400,
    );
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      assert.equal((await command("missions.list", { tags: [`a${String.fromCharCode(code)}b`] })).status, 400);
    }
    assert.equal((await command("missions.list", { tags: ["équipe:龍🎲"] })).status, 200);
    const filtered = await (await command("missions.list", { tags: ["readability"], limit: 1 })).json();
    assert.equal(filtered.total, 1);
    assert.equal(filtered.missions[0].mission, mission.mission);
    assert.equal((await (await command("missions.list", { tags: ["absent"] })).json()).total, 0);
    assert.equal((await (await command("missions.list", { search: "' OR true --" })).json()).total, 0);
    const mcp = async (method, params) =>
      await (
        await fetch(`${endpoint}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json();
    const tools = await mcp("tools/list", {});
    assert.ok(tools.result.tools.some((tool) => tool.name === "trust_extension_coordination"));
    const listed = await mcp("tools/call", {
      name: "trust_extension_coordination",
      arguments: { command: "missions.list", arguments: { tags: ["readability"] } },
    });
    assert.ok(!listed.result.isError);
    assert.match(listed.result.content[0].text, /extension-observation/);
    const changedViaMcp = await mcp("tools/call", {
      name: "trust_extension_coordination",
      arguments: {
        command: "tags.replace",
        arguments: { mission: mission.mission, expectedRevision: 1, tags: ["project:trust"] },
      },
    });
    assert.ok(!changedViaMcp.result.isError);
    assert.equal((await (await command("missions.list", { tags: ["readability"] })).json()).total, 0);
    assert.equal((await fetch(`${endpoint}/extensions/coordination/api/missions?limit=1000`)).status, 400);
    assert.equal((await fetch(`${endpoint}/extensions/coordination/api/missions?sql=select`)).status, 400);
    assert.equal((await lifecycle("stop")).ok, true);
    eventsAbort.abort();
    await collecting;
    assert.equal((await catalog()).state, "STOPPED");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM trust_coordination.missions")).rows[0].n, 1);
    // Independent external work remains possible while the read extension is stopped.
    await db.query("SELECT trust_coordination.mission_claim($1::jsonb)", [
      { mission: mission.mission, actor: mission.assignee },
    ]);
    assert.equal((await lifecycle("start")).ok, true);
    const reread = await (await fetch(`${endpoint}/extensions/coordination/api/missions`)).json();
    assert.equal(reread.missions[0].state, "claimed");
    assert.deepEqual(reread.missions[0].tags, ["project:trust"]);
    assert.equal(reread.missions[0].tagRevision, 2);
    const second = { ...mission, mission: "second-observation", instructions: "Different task" };
    await db.query("SELECT trust_coordination.mission_create($1::jsonb)", [second]);
    const olderMatch = await (await command("missions.list", { tags: ["project:trust"], limit: 1 })).json();
    assert.equal(olderMatch.missions[0].mission, mission.mission, "filter applied before limiting newer untagged rows");
    // Suggestions search all matching database rows, including values absent from the latest card page.
    for (let index = 0; index < 55; index++) {
      const suffix = String(index).padStart(2, "0");
      await db.query("SELECT trust_coordination.mission_create($1::jsonb)", [
        {
          ...mission,
          mission: `suggestion-${suffix}`,
          project: `Suggestion project ${suffix}`,
          assignee: `suggestion-agent-${index % 2}`,
          instructions: "Autocomplete acceptance scope",
        },
      ]);
    }
    const latestPage = await (await command("missions.list", { limit: 50 })).json();
    assert.equal(
      latestPage.missions.some((value) => value.project === "acceptance"),
      false,
    );
    const suggest = async (args) => {
      const response = await command("missions.suggest", args);
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await suggest({ field: "project", query: "ACCEPTANCE" }), {
      field: "project",
      query: "ACCEPTANCE",
      values: ["acceptance"],
      hasMore: false,
      limit: 10,
    });
    const bounded = await suggest({ field: "project", query: "Suggestion", limit: 2 });
    assert.deepEqual(bounded.values, ["Suggestion project 00", "Suggestion project 01"]);
    assert.equal(bounded.hasMore, true);
    assert.equal(bounded.limit, 2);
    assert.deepEqual((await suggest({ field: "project", state: "claimed" })).values, ["acceptance"]);
    assert.deepEqual(
      (await suggest({ field: "project", assignee: "suggestion-agent-1", query: "project 0", limit: 20 })).values,
      [
        "Suggestion project 01",
        "Suggestion project 03",
        "Suggestion project 05",
        "Suggestion project 07",
        "Suggestion project 09",
      ],
    );
    assert.deepEqual((await suggest({ field: "assignee", project: "Suggestion project 00" })).values, [
      "suggestion-agent-0",
    ]);
    assert.deepEqual((await suggest({ field: "assignee", search: "Autocomplete acceptance scope" })).values, [
      "suggestion-agent-0",
      "suggestion-agent-1",
    ]);
    assert.deepEqual((await suggest({ field: "project", tags: ["project:trust"] })).values, ["acceptance"]);
    assert.deepEqual((await suggest({ field: "project", tags: ["project:trust", "missing"] })).values, []);
    assert.deepEqual((await suggest({ field: "tags", state: "claimed", query: "TRUST" })).values, ["project:trust"]);
    assert.deepEqual((await suggest({ field: "tags", project: "Suggestion project 00" })).values, []);
    for (const query of ["' OR true --", "%", "_"])
      assert.deepEqual(
        (await suggest({ field: "project", query })).values,
        [],
        "query characters are literal, not SQL or wildcard syntax",
      );
    for (const args of [
      {},
      { field: "plan" },
      { field: "project", limit: 21 },
      { field: "tags", limit: 0 },
      { field: "project", query: null },
      { field: "project", query: "x".repeat(1025) },
      { field: "project", query: "\0" },
      { field: "project", offset: 0 },
      { field: "project", tags: ["same", "same"] },
    ])
      assert.equal((await command("missions.suggest", args)).status, 400);
    const suggestionsViaMcp = await mcp("tools/call", {
      name: "trust_extension_coordination",
      arguments: { command: "missions.suggest", arguments: { field: "project", state: "claimed" } },
    });
    assert.ok(!suggestionsViaMcp.result.isError);
    assert.match(
      suggestionsViaMcp.result.content[0].text,
      /1 project suggestions from matching missions\.[\s\S]*- acceptance/,
    );
    assert.equal(
      tools.result.tools
        .find((tool) => tool.name === "trust_extension_coordination")
        .inputSchema.properties.command.enum.includes("missions.suggest"),
      true,
    );
    assert.equal((await lifecycle("stop")).ok, true);
    assert.equal((await command("missions.suggest", { field: "project" })).status, 409);
    const savedTags = (
      await db.query("SELECT mission,tags,revision,change_id FROM trust_coordination.tags ORDER BY mission")
    ).rows;
    await db.query("CREATE SCHEMA trust_coordination_classification");
    await db.query("ALTER SEQUENCE trust_coordination.changes SET SCHEMA trust_coordination_classification");
    await db.query("ALTER TABLE trust_coordination.tags SET SCHEMA trust_coordination_classification");
    assert.equal((await lifecycle("start")).ok, false, "the legacy tag location is not silently accepted");
    assert.equal((await lifecycle("prepare")).ok, true, "explicit preparation consolidates an existing installation");
    assert.deepEqual(
      (await db.query("SELECT mission,tags,revision,change_id FROM trust_coordination.tags ORDER BY mission")).rows,
      savedTags,
      "consolidation preserves tag rows, revisions and change IDs",
    );
    assert.equal(
      (await db.query("SELECT to_regnamespace('trust_coordination_classification') AS schema")).rows[0].schema,
      null,
    );
    assert.equal((await lifecycle("start")).ok, true);
    assert.deepEqual((await (await command("missions.list", { tags: ["project:trust"] })).json()).missions[0].tags, [
      "project:trust",
    ]);
    assert.equal((await lifecycle("stop")).ok, true);
    // Explicit test-owned damage must be refused, not repaired by a subsequent prepare.
    await db.query("ALTER TABLE trust_coordination.missions RENAME COLUMN response TO incompatible_response");
    assert.equal((await lifecycle("prepare")).ok, false);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM trust_coordination.missions")).rows[0].n, 57);
    assert.equal((await fetch(`${endpoint}/health`)).status, 200);
  } finally {
    eventsAbort?.abort();
    if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
      const exit = once(runtime, "exit");
      runtime.kill("SIGTERM");
      const force = setTimeout(() => runtime.kill("SIGKILL"), 7000);
      await exit;
      clearTimeout(force);
    }
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
