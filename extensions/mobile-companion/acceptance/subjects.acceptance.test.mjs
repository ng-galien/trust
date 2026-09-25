import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startPublicRuntime } from "../../../packages/trust-runtime/dist/acceptance/support/runtime-process.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("a durable subject reads explicit, verified source links through the public API", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-mobile-subject-"));
  const installation = path.join(directory, "extensions.json");
  await writeFile(
    installation,
    JSON.stringify({
      extensions: [
        {
          manifest: path.join(root, "extensions/mobile-companion/extension.json"),
          configuration: { databasePath: path.join(directory, "pglite") },
          environment: "local",
          grants: ["plans.read", "plans.subscribe"],
          autoStart: false,
        },
      ],
    }),
  );
  const runtime = await startPublicRuntime("trust-mobile-subject-runtime-", { extensionsFile: installation });
  const base = `${runtime.endpoint}/extensions/mobile-companion`;
  const transition = (action) =>
    fetch(`${base}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const command = (name, args) =>
    fetch(`${base}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: name, arguments: args }),
    });
  try {
    assert.equal((await transition("prepare")).status, 200);
    assert.equal((await transition("start")).status, 200);
    assert.equal((await command("projects.put", { id: "trust", title: "TRUST", status: "active" })).status, 200);
    assert.equal(
      (
        await command("feed.publish", {
          id: "article",
          project: "trust",
          kind: "explanation",
          title: "Article",
          summary: "Article",
          body: "# Article",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await command("feed.publish", {
          id: "document",
          project: "trust",
          kind: "document",
          title: "Design",
          summary: "Design",
          body: "Design",
          documentUrl: "/mobile/apps/maket/documents/one/read",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await command("feed.publish", {
          id: "episode",
          project: "trust",
          kind: "progress",
          title: "Episode",
          summary: "Plan",
          body: "Plan",
          plan: "plan-one",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await command("feed.publish", {
          id: "unanswered",
          project: "trust",
          kind: "decision",
          title: "Pending decision",
          summary: "Pending",
          body: "No answer has been recorded.",
        })
      ).status,
      201,
    );
    const links = [
      {
        id: "article",
        kind: "article",
        relation: "Reference article",
        description: "Analysis",
        item: "article",
        targetIdentity: "article",
        provenance: "Operator curation on 2026-09-25",
      },
      {
        id: "document",
        kind: "document",
        relation: "Design document",
        description: "Maket",
        item: "document",
        targetIdentity: "/mobile/apps/maket/documents/one/read",
        provenance: "Maket document link recorded on 2026-09-25",
      },
      {
        id: "plan",
        kind: "plan",
        relation: "Tracked execution",
        description: "TRUST Plan",
        item: "episode",
        targetIdentity: "plan-one",
        provenance: "Plan engaged for this task on 2026-09-25",
      },
    ];
    const input = {
      id: "mobile",
      project: "trust",
      title: "Mobile companion",
      description: "One durable subject",
      expectedRevision: 0,
      links,
    };
    assert.equal(
      (
        await command("subjects.put", {
          ...input,
          links: [{ ...links[1], targetIdentity: "/mobile/apps/maket/documents/other/read" }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await command("subjects.put", {
          ...input,
          links: [
            {
              id: "decision",
              kind: "decision",
              relation: "Decision",
              description: "Human response",
              item: "unanswered",
              targetIdentity: "unanswered",
              provenance: "Operator curation",
            },
          ],
        })
      ).status,
      400,
    );
    assert.equal((await (await fetch(`${base}/api/subjects?project=trust`)).json()).subjects.length, 0);
    assert.equal((await command("subjects.put", input)).status, 201);
    const subject = await (await fetch(`${base}/api/subjects/mobile`)).json();
    assert.equal(subject.revision, 1);
    assert.deepEqual(subject.links, links);
    assert.equal((await command("subjects.put", input)).status, 409);
    assert.equal((await command("subjects.put", { ...input, expectedRevision: 1, title: "Mobile work" })).status, 200);
    assert.equal((await (await fetch(`${base}/api/subjects/mobile`)).json()).revision, 2);
    assert.equal((await transition("stop")).status, 200);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
