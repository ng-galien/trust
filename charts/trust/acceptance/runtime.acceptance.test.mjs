import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { prepareRuntime, temporary, rpc, rm } from "./support.mjs";

test("HELM-RUNTIME rendered deployment starts the real configured TRUST server", { timeout: 90000 }, async () => {
  const directory = await temporary();
  let runtime;
  try {
    runtime = await prepareRuntime(directory);
    const inspected = JSON.parse(
      execFileSync(process.execPath, [runtime.command[0], "server", "config"], {
        env: runtime.environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    assert.ok(
      JSON.stringify(inspected).includes("trust.example.com"),
      "Public config command exposes configured external semantic authority",
    );
    await runtime.start();
    const health = await fetch(runtime.endpoint + "/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "trust-runtime");
    assert.match(await (await fetch(runtime.endpoint)).text(), /<title>TRUST<\/title>/);
    const anonymous = await fetch(runtime.endpoint + "/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "environment.list", params: {} }),
    });
    assert.equal(anonymous.status, 401);
    const authorized = await rpc(runtime, "environment.list");
    assert.ok(authorized !== undefined, "Actual TLS issuer token passes the configured verifier");
    assert.ok(!runtime.output.includes(runtime.identity.token), "Startup output must not expose bearer credentials");
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
