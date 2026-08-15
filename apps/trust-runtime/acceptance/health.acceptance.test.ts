import assert from "node:assert/strict";
import { test } from "node:test";
import { startPublicRuntime } from "./support/runtime-process.js";

test("the built runtime exposes its public health boundary", async (context) => {
  const running = await startPublicRuntime("trust-health-");
  context.after(() => running.close());

  const response = await fetch(`${running.endpoint}/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.service, "trust-runtime");
  assert.match(String(body.currentTime), /^\d{4}-\d{2}-\d{2}T/);
});
