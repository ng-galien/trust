import assert from "node:assert/strict";
import test from "node:test";
import { denied, rpc } from "./access-ownership-support.mjs";
import { createExtensionAccessFixture } from "./extension-access-fixture.mjs";
import { configuredRuntime } from "./server-configuration-support.mjs";

test("CONFIG-TRANSPORT configured server preserves HTTP auth and extension behavior", { timeout: 120000 }, async () => {
  const fixture = await createExtensionAccessFixture({ start: configuredRuntime });
  try {
    const { endpoint, alice, bob } = fixture;
    assert.equal((await fetch(`${endpoint}/health`)).status, 200);
    await denied(endpoint, undefined, "plan.list", {});
    await denied(endpoint, bob.token, "plan.read", { plan: "alice-plan" });
    const own = await rpc(endpoint, alice.token, "plan.read", { plan: "alice-plan" });
    assert.equal(own.creator.subject, "alice");
    assert.match(JSON.stringify(own), /trust:\/\/configured\.example:443\//);
    assert.equal((await fixture.command("extension-a", alice.token, "records.read", {})).status, 200);
    const onlyCore = await fixture.provider.issue({ subject: "alice", scope: "trust.plan.read.own" });
    assert.equal((await fixture.command("extension-a", onlyCore.token, "records.read", {})).status, 403);
    fixture.okay(
      await fixture.command("extension-b", alice.token, "records.put", {
        id: "configured-project",
        title: "Configured project",
        description: "Created through configured shell",
        status: "active",
      }),
    );
    assert.equal((await fixture.read("extension-b", bob.token, "/records")).status, 200);
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
        params: { name: "trust_extension_extension_a", arguments: { command: "records.read", arguments: {} } },
      }),
    });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /forbidden|unauthenticated/);
  } finally {
    await fixture.close();
  }
});
