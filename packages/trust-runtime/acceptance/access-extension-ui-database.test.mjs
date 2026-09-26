import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionAccessFixture } from "./access-extension-access-support.mjs";

test("EXTENSION-UI allowed commands persist and forbidden writes leave data unchanged", {
  timeout: 90000,
}, async () => {
  const fixture = await createExtensionAccessFixture("postgresql");
  try {
    const denied = await fixture.provider.issue({ subject: "bob", scope: "trust.extension.list trust.plan.read.own" });
    // Extension use alone authorizes extension-owned data, but does not grant the core Plan bridge.
    const extensionOnly = await fixture.provider.issue({
      subject: "alice",
      scope: "trust.extension.coordination.use trust.extension.mobile-companion.use",
    });
    const hidden = await fixture.request("/extensions/coordination/trust/plans/alice-plan", extensionOnly.token);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.error.code, "plan-not-found");
    fixture.okay(
      await fixture.command("coordination", extensionOnly.token, "tags.replace", {
        mission: "alice-mission",
        expectedRevision: 0,
        tags: ["database-confirmed"],
      }),
    );
    fixture.okay(
      await fixture.command("mobile-companion", extensionOnly.token, "responses.submit", {
        item: "alice-item",
        expectedRevision: 0,
        answers: { decision: "Approve" },
      }),
    );
    const tagsBefore = (
      await fixture.extensionDatabase.query(
        "SELECT mission,tags,revision FROM trust_coordination_classification.tags ORDER BY mission",
      )
    ).rows;
    const responsesBefore = (
      await fixture.extensionDatabase.query(
        "SELECT item,field_id,choice_value FROM trust_mobile_companion.response_values ORDER BY item,field_id",
      )
    ).rows;
    assert.deepEqual(tagsBefore, [{ mission: "alice-mission", tags: ["database-confirmed"], revision: 1 }]);
    assert.deepEqual(responsesBefore, [{ item: "alice-item", field_id: "decision", choice_value: "Approve" }]);
    for (const token of [undefined, denied.token]) {
      assert.equal(
        (
          await fixture.command("coordination", token, "tags.replace", {
            mission: "alice-mission",
            expectedRevision: 1,
            tags: ["forbidden"],
          })
        ).status,
        token ? 403 : 401,
      );
      assert.equal(
        (
          await fixture.command("mobile-companion", token, "responses.submit", {
            item: "bob-item",
            expectedRevision: 0,
            answers: { decision: "Revise" },
          })
        ).status,
        token ? 403 : 401,
      );
    }
    assert.deepEqual(
      (
        await fixture.extensionDatabase.query(
          "SELECT mission,tags,revision FROM trust_coordination_classification.tags ORDER BY mission",
        )
      ).rows,
      tagsBefore,
    );
    assert.deepEqual(
      (
        await fixture.extensionDatabase.query(
          "SELECT item,field_id,choice_value FROM trust_mobile_companion.response_values ORDER BY item,field_id",
        )
      ).rows,
      responsesBefore,
    );
    assert.equal((await fixture.read("mobile-companion", denied.token, "/items/alice-item")).status, 403);
    // Data is shared inside an authorized extension; business labels do not become account ownership.
    fixture.okay(
      await fixture.command("coordination", fixture.bob.token, "tags.replace", {
        mission: "alice-mission",
        expectedRevision: 1,
        tags: ["shared-extension"],
      }),
    );
    assert.deepEqual(
      (
        await fixture.extensionDatabase.query(
          "SELECT tags,revision FROM trust_coordination_classification.tags WHERE mission=$1",
          ["alice-mission"],
        )
      ).rows,
      [{ tags: ["shared-extension"], revision: 2 }],
    );
  } finally {
    await fixture.close();
  }
});
