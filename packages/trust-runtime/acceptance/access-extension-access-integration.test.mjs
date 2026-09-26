import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionAccessFixture } from "./access-extension-access-support.mjs";
import { denied, engage, rpc } from "./access-ownership-support.mjs";

test("EXTENSION-ACCESS real child HTTP and MCP isolate principals and resource permissions", {
  timeout: 120000,
}, async () => {
  const f = await createExtensionAccessFixture();
  const abort = new AbortController();
  try {
    const [coordination, mobile, none, probeAlice, probeBob] = await Promise.all([
      f.provider.issue({ subject: "alice", scope: "trust.extension.coordination.use" }),
      f.provider.issue({ subject: "bob", scope: "trust.extension.mobile-companion.use" }),
      f.provider.issue({ subject: "alice", scope: "trust.plan.read.own" }),
      f.provider.issue({ subject: "alice", scope: "trust.extension.dragon-heist.use" }),
      f.provider.issue({ subject: "bob", scope: "trust.extension.dragon-heist.use" }),
    ]);
    assert.equal((await f.read("coordination", undefined, "/missions")).status, 401);
    assert.equal((await f.command("coordination", none.token, "missions.list", {})).status, 403);
    assert.equal((await f.read("coordination", mobile.token, "/missions")).status, 403);
    assert.equal((await f.command("mobile-companion", coordination.token, "projects.list", {})).status, 403);
    assert.equal(
      f.okay(await f.read("coordination", coordination.token, "/missions")).total,
      3,
      "extension-owned records are globally visible with that extension's use permission",
    );
    assert.deepEqual(
      new Set(f.okay(await f.command("mobile-companion", mobile.token, "feed.list", {})).items.map((item) => item.id)),
      new Set(["alice-item", "bob-item", "unlinked-item"]),
    );
    assert.equal(
      (await f.request("/extensions", coordination.token)).status,
      403,
      "extension catalog remains independently authorized",
    );
    assert.equal((await f.request("/extensions/coordination/trust/plans", coordination.token)).status, 403);
    const own = f.okay(await f.request("/extensions/coordination/trust/plans", f.alice.token));
    assert.deepEqual(
      own.plans.map((plan) => plan.plan),
      ["alice-plan"],
    );
    assert.equal((await f.request("/extensions/coordination/trust/plans/bob-plan", f.alice.token)).status, 404);
    assert.equal(
      (await f.request("/extensions/coordination/start", coordination.token, { method: "POST", body: {} })).status,
      403,
    );
    await denied(f.endpoint, coordination.token, "plan.close", { plan: "alice-plan" });
    await denied(f.endpoint, coordination.token, "credential.list", {});
    await denied(f.endpoint, coordination.token, "procedure.publish", {
      source: "forbidden",
      sourceName: "forbidden.feature",
    });
    const mcp = async (token, id, command, args) => {
      const response = await fetch(`${f.endpoint}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: `trust_extension_${id.replaceAll("-", "_")}`, arguments: { command, arguments: args } },
        }),
      });
      return response.json();
    };
    const accepted = await mcp(coordination.token, "coordination", "missions.list", {});
    assert.equal(accepted.result.isError, undefined);
    assert.match(accepted.result.content[0].text, /bob-mission/);
    const wrong = await mcp(coordination.token, "mobile-companion", "feed.list", {});
    assert.equal(wrong.result.isError, true);
    assert.match(wrong.result.content[0].text, /Access denied/);
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const credential = i % 2 ? probeBob : probeAlice;
        const result = f.okay(
          await f.command("dragon-heist", credential.token, "identity.read", {
            delay: 12 - i,
            principal: { subject: "forged" },
            context: { mode: "local" },
          }),
        );
        assert.deepEqual(result.principal, { issuer: f.provider.issuer, subject: i % 2 ? "bob" : "alice" });
        assert.equal(result.extensionId, "dragon-heist");
        assert.ok(!JSON.stringify(result).includes(credential.token));
      }),
    );
    assert.equal(results.length, 12);
    assert.equal(
      (
        await f.request("/extensions/dragon-heist/commands", probeAlice.token, {
          method: "POST",
          body: { command: "identity.read", arguments: {}, context: { mode: "local" } },
        })
      ).status,
      400,
    );
    const stream = await fetch(`${f.endpoint}/extensions/coordination/events`, {
      signal: abort.signal,
      headers: { authorization: `Bearer ${coordination.token}` },
    });
    assert.equal(stream.status, 200, "extension-owned events need use, not a core Plan permission");
    const reader = stream.body.getReader();
    let observed = "",
      ended = false;
    const reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true;
            return;
          }
          observed += Buffer.from(value).toString();
        }
      } catch {}
    })();
    await new Promise((resolve) => setTimeout(resolve, 16000));
    assert.equal(ended, false, "idle extension permission revalidation must accept its exact use scope");
    f.okay(
      await f.command("coordination", coordination.token, "tags.replace", {
        mission: "bob-mission",
        expectedRevision: 0,
        tags: ["shared-use"],
      }),
    );
    await rpc(f.endpoint, f.bob.token, "plan.engage", engage("new-bob-plan"));
    for (let i = 0; i < 100 && !observed.includes("extension.changed"); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(observed, /extension.changed/);
    assert.doesNotMatch(observed, /new-bob-plan|plan.changed/);
    abort.abort();
    await reading;
  } finally {
    abort.abort();
    await f.close();
  }
});
