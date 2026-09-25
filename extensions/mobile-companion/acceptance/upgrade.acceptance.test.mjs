import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { publicMcp } from "../../../environments/trust-test/scripts/lib/public-mcp.mjs";
import { startPublicRuntime } from "../../../packages/trust-runtime/dist/acceptance/support/runtime-process.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const run = promisify(execFile);

test("an offline v1 answer survives explicit v2 through v5 upgrades through the public extension", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-mobile-upgrade-"));
  const seed = path.join(directory, "seed-v1");
  const backup = path.join(directory, "backup-v1");
  const candidate = path.join(directory, "candidate-v2");
  const backupV2 = path.join(directory, "backup-v2");
  const candidateV3 = path.join(directory, "candidate-v3");
  const backupV3 = path.join(directory, "backup-v3");
  const candidateV4 = path.join(directory, "candidate-v4");
  const backupV4 = path.join(directory, "backup-v4");
  const candidateV5 = path.join(directory, "candidate-v5");
  const different = path.join(directory, "different-v1");
  const installations = path.join(directory, "extensions.json");
  let runtime;
  try {
    const db = await PGlite.create(seed);
    await db.exec(await readFile(new URL("./schema-v1.sql", import.meta.url), "utf8"));
    await db.transaction(async (tx) => {
      await tx.exec(`
        INSERT INTO trust_mobile_companion.projects(id,title,description,status)
          VALUES ('project','Project','','active');
        INSERT INTO trust_mobile_companion.items(id,project,kind,title,summary,body)
          VALUES ('decision','project','decision','Decision','Choose','Choose an option.');
        INSERT INTO trust_mobile_companion.forms(item,revision) VALUES ('decision',1);
        INSERT INTO trust_mobile_companion.form_fields(item,field_id,position,label,field_type,required)
          VALUES ('decision','choice',0,'Choice','choice',true),
                 ('decision','note',1,'Note','text',false);
        INSERT INTO trust_mobile_companion.form_options(item,field_id,value,position)
          VALUES ('decision','choice','Proceed',0),('decision','choice','Pause',1);
        INSERT INTO trust_mobile_companion.responses(item,revision,submitted_at)
          VALUES ('decision',1,'2026-09-23T10:11:12Z');
        INSERT INTO trust_mobile_companion.response_values(item,field_id,choice_value,text_value)
          VALUES ('decision','choice','Pause',NULL),('decision','note',NULL,'Retain this answer');
      `);
    });
    await db.close();
    await cp(seed, backup, { recursive: true });
    await cp(seed, candidate, { recursive: true });
    await cp(seed, different, { recursive: true });
    const changed = await PGlite.create(different);
    await changed.query("UPDATE trust_mobile_companion.projects SET title='Changed' WHERE id='project'");
    await changed.close();
    await assert.rejects(
      run(process.execPath, [
        path.join(root, "extensions/mobile-companion/scripts/upgrade-v1-v2.mjs"),
        different,
        backup,
      ]),
      /Source and backup legacy data differ; migration refused/,
    );
    const refused = await PGlite.create(different);
    assert.equal((await refused.query("SELECT version FROM trust_mobile_companion.schema_version")).rows[0].version, 1);
    await refused.close();

    const { stdout } = await run(process.execPath, [
      path.join(root, "extensions/mobile-companion/scripts/upgrade-v1-v2.mjs"),
      candidate,
      backup,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.version, 2);
    assert.equal(result.counts.responses, 1);
    assert.equal(result.counts.response_values, 2);
    await assert.rejects(
      run(process.execPath, [
        path.join(root, "extensions/mobile-companion/scripts/upgrade-v1-v2.mjs"),
        candidate,
        backup,
      ]),
      /Source requires mobile schema v1; found v2/,
    );
    await cp(candidate, backupV2, { recursive: true });
    await cp(candidate, candidateV3, { recursive: true });
    const upgraded = JSON.parse(
      (
        await run(process.execPath, [
          path.join(root, "extensions/mobile-companion/scripts/upgrade-v2-v3.mjs"),
          candidateV3,
          backupV2,
        ])
      ).stdout,
    );
    assert.equal(upgraded.version, 3);
    assert.equal(upgraded.dataUnchanged, true);
    assert.equal(upgraded.counts.response_values, 2);
    await assert.rejects(
      run(process.execPath, [
        path.join(root, "extensions/mobile-companion/scripts/upgrade-v2-v3.mjs"),
        candidateV3,
        backupV2,
      ]),
      /Source requires mobile schema v2/,
    );
    await cp(candidateV3, backupV3, { recursive: true });
    await cp(candidateV3, candidateV4, { recursive: true });
    const upgradedV4 = JSON.parse(
      (
        await run(process.execPath, [
          path.join(root, "extensions/mobile-companion/scripts/upgrade-v3-v4.mjs"),
          candidateV4,
          backupV3,
        ])
      ).stdout,
    );
    assert.equal(upgradedV4.version, 4);
    assert.equal(upgradedV4.dataUnchanged, true);
    assert.equal(upgradedV4.counts.response_values, 2);
    await cp(candidateV4, backupV4, { recursive: true });
    await cp(candidateV4, candidateV5, { recursive: true });
    const upgradedV5 = JSON.parse(
      (
        await run(process.execPath, [
          path.join(root, "extensions/mobile-companion/scripts/upgrade-v4-v5.mjs"),
          candidateV5,
          backupV4,
        ])
      ).stdout,
    );
    assert.equal(upgradedV5.version, 5);
    assert.equal(upgradedV5.dataUnchanged, true);
    assert.equal(upgradedV5.counts.response_values, 2);
    await writeFile(
      installations,
      JSON.stringify({
        extensions: [
          {
            manifest: path.join(root, "extensions/mobile-companion/extension.json"),
            configuration: { databasePath: candidateV5 },
            environment: "local",
            grants: ["plans.read", "plans.subscribe"],
            autoStart: false,
          },
        ],
      }),
    );
    runtime = await startPublicRuntime("trust-mobile-upgrade-runtime-", { extensionsFile: installations });
    const base = `${runtime.endpoint}/extensions/mobile-companion`;
    assert.equal(
      (await fetch(`${base}/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
        .status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
        .status,
      200,
    );
    const expected = {
      item: "decision",
      formRevision: 1,
      responseRevision: 1,
      submittedAt: "2026-09-23T10:11:12.000Z",
      answers: { choice: "Pause", note: "Retain this answer" },
    };
    assert.deepEqual(await (await fetch(`${base}/api/responses/decision`)).json(), expected);
    assert.deepEqual(
      JSON.parse(
        await publicMcp(runtime.endpoint, "trust_extension_mobile_companion", {
          command: "responses.read",
          arguments: { item: "decision" },
        }),
      ),
      expected,
    );
    assert.equal(
      (await fetch(`${base}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
        .status,
      200,
    );
    await runtime.close();
    runtime = undefined;
    const backupDb = await PGlite.create(backup);
    assert.equal(
      (await backupDb.query("SELECT version FROM trust_mobile_companion.schema_version")).rows[0].version,
      1,
    );
    assert.equal(
      (await backupDb.query("SELECT count(*)::integer AS count FROM trust_mobile_companion.response_values")).rows[0]
        .count,
      2,
    );
    await backupDb.close();
    const v2Db = await PGlite.create(backupV2);
    assert.equal((await v2Db.query("SELECT version FROM trust_mobile_companion.schema_version")).rows[0].version, 2);
    await v2Db.close();
    const v3Db = await PGlite.create(candidateV3);
    const legacyPost = (
      await v3Db.query(
        "SELECT body,template_id,template_version,data,rendered_markdown FROM trust_mobile_companion.items WHERE id='decision'",
      )
    ).rows[0];
    assert.equal(legacyPost.body, "Choose an option.");
    assert.equal(legacyPost.template_id, null);
    assert.equal(legacyPost.template_version, null);
    assert.equal(legacyPost.data, null);
    assert.equal(legacyPost.rendered_markdown, null);
    assert.equal(
      (await v3Db.query("SELECT count(*)::integer AS count FROM trust_mobile_companion.post_templates")).rows[0].count,
      0,
    );
    await v3Db.close();
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
