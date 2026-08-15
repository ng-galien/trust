import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import type {
  CheckFactBatchInput,
  PlanRuntimeService,
} from "../src/application/plan-runtime-service.js";
import type { RegistryAuthority } from "../src/ports/registry-authority.js";
import { createOtlpHttpHandler } from "../src/presentation/otlp-http.js";

test("OTLP preserves structured Fact keys through the public HTTP endpoint", async (context) => {
  let received: CheckFactBatchInput | undefined;
  const app = express();
  app.use("/v1/traces", createOtlpHttpHandler({
    planRuntimeService: {
      ingestCheckFacts(batch: CheckFactBatchInput) {
        received = batch;
      },
    } as PlanRuntimeService,
    registryAuthority: {} as RegistryAuthority,
  }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(traceWithPrototypeKey()),
  });

  assert.equal(response.status, 200);
  assert.ok(received);
  const values = received.facts[0]?.values;
  assert.ok(values);
  assert.equal(Object.hasOwn(values, "__proto__"), true);
  assert.equal(Reflect.get(values, "__proto__"), "preserved");
  assert.equal(Object.getPrototypeOf(values), Object.prototype);
});

function traceWithPrototypeKey(): Readonly<Record<string, unknown>> {
  const timeUnixNano = (BigInt(Date.parse("2026-08-15T12:00:00.000Z")) * 1_000_000n).toString();
  return {
    resourceSpans: [{
      scopeSpans: [{
        spans: [{
          name: "trust.runner.facts",
          startTimeUnixNano: timeUnixNano,
          attributes: [
            stringAttribute("trust.attempt_key", "attempt-1"),
            stringAttribute("trust.execution_handle", "execution-1"),
            stringAttribute("trust.check_uri", "trust://local/example@1.0.0/plan/scenario/check/target"),
          ],
          events: [{
            name: "trust.runner.fact",
            attributes: [
              { key: "trust.fact.index", value: { intValue: "0" } },
              stringAttribute("trust.fact.kind", "example.read"),
              stringAttribute("trust.fact.observed_at", "2026-08-15T12:00:00.000Z"),
              {
                key: "trust.fact.values",
                value: {
                  kvlistValue: {
                    values: [
                      { key: "__proto__", value: { stringValue: "preserved" } },
                    ],
                  },
                },
              },
            ],
          }],
        }],
      }],
    }],
  };
}

function stringAttribute(key: string, value: string): Readonly<Record<string, unknown>> {
  return { key, value: { stringValue: value } };
}
