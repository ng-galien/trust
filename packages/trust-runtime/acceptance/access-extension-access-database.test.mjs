import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionAccessFixture } from "./access-extension-access-support.mjs";

test("EXTENSION-ACCESS actual extension stores preserve allowed changes and deny foreign mutations", {
  timeout: 120000,
}, async (t) => {
  for (const kind of ["pglite", "postgresql"]) {
    const f = await createExtensionAccessFixture(kind);
    try {
      const coordination = await f.provider.issue({ subject: "alice", scope: "trust.extension.coordination.use" });
      const mobile = await f.provider.issue({ subject: "bob", scope: "trust.extension.mobile-companion.use" });
      const before = (await f.extensionDatabase.query("SELECT * FROM trust_coordination.tags ORDER BY mission")).rows;
      assert.equal(
        (
          await f.command("coordination", mobile.token, "tags.replace", {
            mission: "alice-mission",
            expectedRevision: 0,
            tags: ["forbidden"],
          })
        ).status,
        403,
      );
      assert.deepEqual(
        (await f.extensionDatabase.query("SELECT * FROM trust_coordination.tags ORDER BY mission")).rows,
        before,
      );
      f.okay(
        await f.command("coordination", coordination.token, "tags.replace", {
          mission: "historical-mission",
          expectedRevision: 0,
          tags: ["global-extension-data"],
        }),
      );
      assert.equal(
        (
          await f.extensionDatabase.query(
            "SELECT revision FROM trust_coordination.tags WHERE mission='historical-mission'",
          )
        ).rows[0].revision,
        1,
      );
      assert.equal(
        (
          await f.command("mobile-companion", coordination.token, "responses.submit", {
            item: "bob-item",
            expectedRevision: 0,
            answers: { decision: "Approve" },
          })
        ).status,
        403,
      );
      assert.equal(
        (await f.extensionDatabase.query("SELECT count(*)::int AS count FROM trust_mobile_companion.responses")).rows[0]
          .count,
        0,
      );
      const races = await Promise.all(
        ["Approve", "Revise"].map((decision) =>
          f.command("mobile-companion", mobile.token, "responses.submit", {
            item: "alice-item",
            expectedRevision: 0,
            answers: { decision },
          }),
        ),
      );
      assert.equal(races.filter((result) => result.status === 201).length, 1);
      assert.equal(races.filter((result) => result.status === 409).length, 1);
      const saved = f.okay(await f.command("mobile-companion", mobile.token, "responses.read", { item: "alice-item" }));
      assert.equal(
        (
          await f.extensionDatabase.query(
            "SELECT count(*)::int AS count FROM trust_mobile_companion.response_values WHERE item='alice-item'",
          )
        ).rows[0].count,
        1,
      );
      for (const id of ["coordination", "mobile-companion"]) {
        f.okay(await f.request(`/extensions/${id}/stop`, f.admin.token, { method: "POST", body: {} }));
        f.okay(await f.request(`/extensions/${id}/start`, f.admin.token, { method: "POST", body: {} }));
      }
      assert.deepEqual(
        f.okay(await f.command("mobile-companion", mobile.token, "responses.read", { item: "alice-item" })),
        saved,
      );
      const missions = f.okay(await f.command("coordination", coordination.token, "missions.list", {}));
      assert.deepEqual(missions.missions.find((mission) => mission.mission === "historical-mission").tags, [
        "global-extension-data",
      ]);
      const columns = (
        await f.extensionDatabase.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='trust_mobile_companion' AND table_name='items'",
        )
      ).rows.map((row) => row.column_name);
      assert.ok(
        !columns.some((name) => /creator|principal|issuer/.test(name)),
        "no extension ownership model is introduced",
      );
      t.diagnostic(`${kind}: real extension writes persisted and wrong-extension mutations left no rows`);
    } finally {
      await f.close();
    }
  }
});
