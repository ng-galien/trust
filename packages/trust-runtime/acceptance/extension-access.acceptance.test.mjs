import assert from "node:assert/strict";
import test from "node:test";
import { denied, engage, rpc } from "./access-ownership-support.mjs";
import { createExtensionAccessFixture } from "./extension-access-fixture.mjs";

test("EXTENSION-ACCESS real child HTTP and MCP isolate principals and resource permissions", {
  timeout: 120000,
}, async () => {
  const f = await createExtensionAccessFixture();
  const abort = new AbortController();
  try {
    const [extensionA, extensionB, none, probeAlice, probeBob] = await Promise.all([
      f.provider.issue({ subject: "alice", scope: "trust.extension.extension-a.use" }),
      f.provider.issue({ subject: "bob", scope: "trust.extension.extension-b.use" }),
      f.provider.issue({ subject: "alice", scope: "trust.plan.read.own" }),
      f.provider.issue({ subject: "alice", scope: "trust.extension.extension-a.use" }),
      f.provider.issue({ subject: "bob", scope: "trust.extension.extension-a.use" }),
    ]);
    assert.equal((await f.read("extension-a", undefined, "/records")).status, 401);
    assert.equal((await f.command("extension-a", none.token, "records.read", {})).status, 403);
    assert.equal((await f.read("extension-a", extensionB.token, "/records")).status, 403);
    assert.equal((await f.command("extension-b", extensionA.token, "records.read", {})).status, 403);
    f.okay(await f.command("extension-a", extensionA.token, "records.put", { id: "shared-record" }));
    assert.equal(f.okay(await f.read("extension-a", extensionA.token, "/records")).records.length, 1);
    assert.equal(
      (await f.request("/extensions", extensionA.token)).status,
      403,
      "extension catalog remains independently authorized",
    );
    assert.equal((await f.request("/extensions/extension-a/trust/plans", extensionA.token)).status, 403);
    const own = f.okay(await f.request("/extensions/extension-a/trust/plans", f.alice.token));
    assert.deepEqual(
      own.plans.map((plan) => plan.plan),
      ["alice-plan"],
    );
    assert.equal((await f.request("/extensions/extension-a/trust/plans/bob-plan", f.alice.token)).status, 404);
    assert.equal(
      (await f.request("/extensions/extension-a/start", extensionA.token, { method: "POST", body: {} })).status,
      403,
    );
    await denied(f.endpoint, extensionA.token, "plan.close", { plan: "alice-plan" });
    await denied(f.endpoint, extensionA.token, "credential.list", {});
    await denied(f.endpoint, extensionA.token, "procedure.publish", {
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
    const accepted = await mcp(extensionA.token, "extension-a", "records.read", {});
    assert.equal(accepted.result.isError, undefined);
    assert.match(accepted.result.content[0].text, /shared-record/);
    const wrong = await mcp(extensionA.token, "extension-b", "records.read", {});
    assert.equal(wrong.result.isError, true);
    assert.match(wrong.result.content[0].text, /Access denied/);
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const credential = i % 2 ? probeBob : probeAlice;
        const result = f.okay(
          await f.command("extension-a", credential.token, "identity.read", {
            delay: 12 - i,
            principal: { subject: "forged" },
            context: { mode: "local" },
          }),
        );
        assert.deepEqual(result.principal, { issuer: f.provider.issuer, subject: i % 2 ? "bob" : "alice" });
        assert.equal(result.extensionId, "extension-a");
        assert.ok(!JSON.stringify(result).includes(credential.token));
      }),
    );
    assert.equal(results.length, 12);
    assert.equal(
      (
        await f.request("/extensions/extension-a/commands", probeAlice.token, {
          method: "POST",
          body: { command: "identity.read", arguments: {}, context: { mode: "local" } },
        })
      ).status,
      400,
    );
    const stream = await fetch(`${f.endpoint}/extensions/extension-a/events`, {
      signal: abort.signal,
      headers: { authorization: `Bearer ${extensionA.token}` },
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
    f.okay(await f.command("extension-a", extensionA.token, "records.put", { id: "shared-event" }));
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
