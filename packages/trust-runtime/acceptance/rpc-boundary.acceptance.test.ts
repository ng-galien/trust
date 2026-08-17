import assert from "node:assert/strict";
import test from "node:test";

import { startPublicRuntime } from "./support/runtime-process.js";

test("the JSON-RPC boundary handles malformed input, notifications, batches and size limits", async () => {
  const runtime = await startPublicRuntime("trust-rpc-boundary-");
  try {
    const malformed = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as RpcEnvelope).error?.code, -32_700);

    const emptyBatch = await post(runtime.endpoint, []);
    assert.equal(emptyBatch.status, 200);
    assert.equal(((await emptyBatch.json()) as RpcEnvelope).error?.code, -32_600);

    const notification = await post(runtime.endpoint, {
      jsonrpc: "2.0",
      method: "environment.list",
      params: {},
    });
    assert.equal(notification.status, 204);
    assert.equal(await notification.text(), "");

    const batch = await post(runtime.endpoint, [
      { jsonrpc: "2.0", id: "catalog", method: "environment.list", params: {} },
      { jsonrpc: "2.0", method: "environment.list", params: {} },
      { jsonrpc: "2.0", id: "unknown", method: "trust.unknown", params: {} },
    ]);
    assert.equal(batch.status, 200);
    const responses = await batch.json() as RpcEnvelope[];
    assert.deepEqual(responses.map(({ id }) => id).sort(), ["catalog", "unknown"]);
    assert.equal(responses.find(({ id }) => id === "catalog")?.result !== undefined, true);
    assert.equal(responses.find(({ id }) => id === "unknown")?.error?.code, -32_601);

    const oversized = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "oversized",
        method: "environment.list",
        params: {},
        padding: "x".repeat(1_100_000),
      }),
    });
    assert.equal(oversized.status, 413);
    const oversizedError = (await oversized.json()) as RpcEnvelope;
    assert.equal(oversizedError.error?.data?.reason, "payload-too-large");
  } finally {
    await runtime.close();
  }
});

interface RpcEnvelope {
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly data?: { readonly reason?: string } };
}

function post(endpoint: string, body: unknown): Promise<Response> {
  return fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
