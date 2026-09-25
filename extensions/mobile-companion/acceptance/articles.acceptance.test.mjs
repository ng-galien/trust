import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { publicMcp } from "../../../environments/trust-test/scripts/lib/public-mcp.mjs";
import { startPublicRuntime } from "../../../packages/trust-runtime/dist/acceptance/support/runtime-process.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("one article URL shows its latest version while imported feed items remain in history", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-mobile-articles-"));
  const data = path.join(directory, "pglite");
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
  const runtime = await startPublicRuntime("trust-mobile-articles-runtime-", { extensionsFile: installations });
  const base = `${runtime.endpoint}/extensions/mobile-companion`;
  const transition = (action) =>
    fetch(`${base}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const mcp = (name, args) =>
    publicMcp(runtime.endpoint, "trust_extension_mobile_companion", { command: name, arguments: args });
  const command = (name, args) =>
    fetch(`${base}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: name, arguments: args }),
    });
  try {
    assert.equal((await transition("prepare")).status, 200);
    assert.equal((await transition("start")).status, 200);
    await mcp("projects.put", { id: "trust", title: "TRUST", status: "active" });
    for (const [id, title, body] of [
      ["benchmark-original", "Benchmark original", "# Original"],
      ["benchmark-short", "Benchmark short", "# Short"],
      ["benchmark-current", "Benchmark current", "# Current"],
    ]) {
      assert.equal(
        (await command("feed.publish", { id, project: "trust", kind: "explanation", title, summary: title, body }))
          .status,
        201,
      );
    }
    const consolidated = JSON.parse(
      await mcp("articles.consolidate", {
        article: "benchmark-original",
        aliases: ["benchmark-short", "benchmark-current"],
      }),
    );
    assert.equal(consolidated.id, "benchmark-original");
    assert.equal(consolidated.body, "# Current");
    assert.equal(consolidated.article.version, 3);
    assert.equal(consolidated.article.history.length, 3);
    const feed = JSON.parse(await mcp("feed.list", { project: "trust" }));
    assert.deepEqual(
      feed.items.map((item) => item.id),
      ["benchmark-original"],
    );
    assert.equal(feed.items[0].title, "Benchmark current");
    assert.equal((await (await fetch(`${base}/api/items/benchmark-original`)).json()).body, "# Current");
    assert.equal((await (await fetch(`${base}/api/items/benchmark-short`)).json()).id, "benchmark-original");
    assert.equal((await (await fetch(`${base}/api/items/benchmark-original?version=1`)).json()).body, "# Original");
    assert.equal((await (await fetch(`${base}/api/items/benchmark-original?version=2`)).json()).body, "# Short");
    assert.equal((await (await fetch(`${base}/api/items/benchmark-original?version=3`)).json()).body, "# Current");
    const revised = JSON.parse(
      await mcp("articles.revise", {
        item: "benchmark-original",
        expectedVersion: 3,
        title: "Benchmark revised",
        summary: "Updated comparison.",
        body: "# Revised",
        author: "acceptance-agent",
        reason: "Clarify the comparison",
      }),
    );
    assert.equal(revised.id, "benchmark-original");
    assert.equal(revised.article.version, 4);
    assert.equal(revised.body, "# Revised");
    assert.equal(revised.article.history[0].author, "acceptance-agent");
    assert.equal(
      (
        await command("articles.revise", {
          item: "benchmark-original",
          expectedVersion: 3,
          title: "Conflict",
          summary: "Conflict",
          body: "# Conflict",
          author: "acceptance-agent",
          reason: "Stale version",
        })
      ).status,
      409,
    );
    assert.equal((await (await fetch(`${base}/api/items/benchmark-original?version=3`)).json()).body, "# Current");
    assert.equal(JSON.parse(await mcp("feed.list", { project: "trust" })).items.length, 1);
    assert.equal((await transition("stop")).status, 200);
  } finally {
    await runtime.close();
  }
  const db = await PGlite.create(data);
  try {
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM trust_mobile_companion.items")).rows[0].n, 3);
    assert.equal(
      (await db.query("SELECT count(*)::integer AS n FROM trust_mobile_companion.article_aliases")).rows[0].n,
      2,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::integer AS n FROM trust_mobile_companion.article_versions WHERE article_id='benchmark-original'",
        )
      ).rows[0].n,
      4,
    );
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
