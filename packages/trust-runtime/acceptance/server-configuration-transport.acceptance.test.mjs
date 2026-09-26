import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionAccessFixture } from "./access-extension-access-support.mjs";
import { denied, rpc } from "./access-ownership-support.mjs";
import { configuredRuntime } from "./server-configuration-support.mjs";

test("CONFIG-TRANSPORT configured server preserves HTTP auth and extension behavior", { timeout: 120000 }, async () => {
  const fixture = await createExtensionAccessFixture("pglite", { start: configuredRuntime });
  try {
    const { endpoint, alice, bob, admin } = fixture;
    assert.equal((await fetch(`${endpoint}/health`)).status, 200);
    await denied(endpoint, undefined, "plan.list", {});
    await denied(endpoint, bob.token, "plan.read", { plan: "alice-plan" });
    const own = await rpc(endpoint, alice.token, "plan.read", { plan: "alice-plan" });
    assert.equal(own.creator.subject, "alice");
    assert.match(JSON.stringify(own), /trust:\/\/configured\.example:443\//);
    assert.equal((await fixture.command("coordination", alice.token, "missions.list", {})).status, 200);
    const onlyCore = await fixture.provider.issue({ subject: "alice", scope: "trust.plan.read.own" });
    assert.equal((await fixture.command("coordination", onlyCore.token, "missions.list", {})).status, 403);
    fixture.okay(
      await fixture.command("mobile-companion", alice.token, "projects.put", {
        id: "configured-project",
        title: "Configured project",
        description: "Created through configured shell",
        status: "active",
      }),
    );
    assert.equal((await fixture.read("mobile-companion", bob.token, "/projects")).status, 200);
    const publicConfig = await (await fetch(`${endpoint}/auth/config`)).json();
    assert.doesNotMatch(JSON.stringify(publicConfig), /clientSecret|connectionString|PGPASSWORD/);
    const response = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.token}`,
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "trust_extension_coordination", arguments: { command: "missions.list", arguments: {} } },
      }),
    });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /forbidden|unauthenticated/);
  } finally {
    await fixture.close();
  }
});
