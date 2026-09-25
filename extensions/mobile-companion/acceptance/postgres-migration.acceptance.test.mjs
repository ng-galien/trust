import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startPublicRuntime } from "../../../packages/trust-runtime/dist/acceptance/support/runtime-process.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const databaseUrl = process.env.TRUST_MOBILE_TEST_DATABASE_URL;

test("closed PGlite v5 content migrates into PostgreSQL and remains readable through the public API", {
  skip: !databaseUrl || !process.env.TRUST_MOBILE_TEST_PASSWORD_FILE,
  timeout: 120000,
}, async () => {
  process.env.PGPASSWORD = (await readFile(process.env.TRUST_MOBILE_TEST_PASSWORD_FILE, "utf8")).trim();
  const directory = await mkdtemp(path.join(tmpdir(), "trust-mobile-pg-migration-"));
  const sourceDirectory = path.join(directory, "source-pglite");
  const sourceConfig = path.join(directory, "source-extensions.json");
  const targetConfig = path.join(directory, "target-extensions.json");
  const manifest = path.join(root, "extensions/mobile-companion/extension.json");
  await writeFile(
    sourceConfig,
    JSON.stringify({
      extensions: [
        {
          manifest,
          configuration: { databasePath: sourceDirectory },
          environment: "local",
          grants: ["plans.read", "plans.subscribe"],
          autoStart: false,
        },
      ],
    }),
  );
  await writeFile(
    targetConfig,
    JSON.stringify({
      extensions: [
        {
          manifest,
          configuration: { databaseUrl },
          credentialEnvironment: ["PGPASSWORD"],
          environment: "local",
          grants: ["plans.read", "plans.subscribe"],
          autoStart: false,
        },
      ],
    }),
  );
  const source = await startPublicRuntime("trust-mobile-pg-source-", { extensionsFile: sourceConfig });
  let target;
  try {
    const base = `${source.endpoint}/extensions/mobile-companion`;
    const transition = (action) =>
      fetch(`${base}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    const command = (name, args) =>
      fetch(`${base}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: name, arguments: args }),
      });
    assert.equal((await transition("prepare")).status, 200);
    assert.equal((await transition("start")).status, 200);
    assert.equal((await command("projects.put", { id: "trust", title: "TRUST", status: "active" })).status, 200);
    assert.equal(
      (
        await command("feed.publish", {
          id: "article",
          project: "trust",
          kind: "explanation",
          title: "First title",
          summary: "First",
          body: "# First",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await command("articles.revise", {
          item: "article",
          expectedVersion: 1,
          title: "Second title",
          summary: "Second",
          body: "# Second",
          author: "editor",
          reason: "Preserve history during migration",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await command("feed.publish", {
          id: "question",
          project: "trust",
          kind: "decision",
          title: "Choose",
          summary: "Choose",
          body: "Please choose.",
          form: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                decision: { type: "string", title: "Decision", enum: ["Approve", "Revise"] },
              },
              required: ["decision"],
            },
          },
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await command("responses.submit", {
          item: "question",
          expectedRevision: 0,
          answers: { decision: "Approve" },
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await command("subjects.put", {
          id: "mobile",
          project: "trust",
          title: "Mobile work",
          description: "Durable subject",
          expectedRevision: 0,
          links: [
            {
              id: "article",
              kind: "article",
              relation: "Reference",
              description: "The article",
              item: "article",
              targetIdentity: "article",
              provenance: "Editorial selection",
            },
          ],
        })
      ).status,
      201,
    );
    await transition("stop");
    await source.close();

    const migration = spawn(
      process.execPath,
      [
        path.join(root, "extensions/mobile-companion/scripts/migrate-pglite-v5-to-postgres.mjs"),
        sourceDirectory,
        databaseUrl,
      ],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    migration.stdout.on("data", (chunk) => {
      output += chunk;
    });
    migration.stderr.on("data", (chunk) => {
      error += chunk;
    });
    const [code] = await once(migration, "exit");
    assert.equal(code, 0, error);
    assert.equal(JSON.parse(output).dataUnchanged, true);

    target = await startPublicRuntime("trust-mobile-pg-target-", { extensionsFile: targetConfig });
    const targetBase = `${target.endpoint}/extensions/mobile-companion`;
    const started = await fetch(`${targetBase}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(started.status, 200, await started.text());
    const article = await (await fetch(`${targetBase}/api/items/article`)).json();
    assert.equal(article.article.version, 2);
    assert.equal(article.title, "Second title");
    const answer = await (await fetch(`${targetBase}/api/responses/question`)).json();
    assert.deepEqual(answer.answers, { decision: "Approve" });
    const subject = await (await fetch(`${targetBase}/api/subjects/mobile`)).json();
    assert.equal(subject.revision, 1);
    assert.equal(subject.links[0].provenance, "Editorial selection");
    assert.equal((await fetch(`${targetBase}/api/notifications/status`)).status, 200);
  } finally {
    await target?.close();
    await source.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
