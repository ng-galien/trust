import assert from "node:assert/strict";
import test from "node:test";
import * as oauth from "openid-client";
import { createAccessTestProvider, DEVELOPMENT_RESOURCE } from "../../../environments/trust-test/auth/provider.mjs";
import { otlpFactAttributes } from "../dist/acceptance/support/otlp-fact.js";
import {
  admit,
  denied,
  engage,
  envelope,
  facts,
  resources,
  rpc,
  runtimeFixture,
  scopes,
  seed,
  storageTarget,
} from "./access-ownership-support.mjs";

test("PLAN-TRANSPORT own and all access isolate real Plans and Attempts", { timeout: 120000 }, async () => {
  const provider = await createAccessTestProvider();
  const target = await storageTarget("pglite");
  let runtime;
  try {
    runtime = await runtimeFixture(provider, target.storage);
    const { endpoint, container } = runtime;
    const [alice, bob, admin] = await Promise.all([
      provider.issue({ subject: "alice", scope: scopes().join(" ") }),
      provider.issue({ subject: "bob", scope: scopes().join(" ") }),
      provider.issue({ subject: "admin", scope: [...scopes("all"), ...resources].join(" ") }),
    ]);
    await seed(endpoint, admin.token);
    const [a, b] = await Promise.all([
      rpc(endpoint, alice.token, "plan.engage", engage("alice-plan")),
      rpc(endpoint, bob.token, "plan.engage", engage("bob-plan")),
    ]);
    assert.deepEqual((await rpc(endpoint, alice.token, "plan.read", { plan: "alice-plan" })).creator, {
      issuer: provider.issuer,
      subject: "alice",
    });
    await denied(endpoint, bob.token, "plan.read", { plan: "alice-plan" });
    await denied(endpoint, bob.token, "plan.engage", engage("alice-plan"));
    await denied(endpoint, bob.token, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri: a.checkUris[0],
    });
    await denied(endpoint, bob.token, "session.read", { plan: "alice-plan" });
    await denied(endpoint, bob.token, "plan.close", { plan: "alice-plan" });
    await denied(endpoint, undefined, "plan.list", {});
    const ownPage = await rpc(endpoint, alice.token, "plan.list", { limit: 1 });
    assert.deepEqual(
      ownPage.plans.map((p) => p.plan),
      ["alice-plan"],
    );
    assert.equal(ownPage.nextCursor, undefined, "a foreign Plan must not produce an own-scope continuation");
    assert.deepEqual(
      (await rpc(endpoint, bob.token, "plan.list", { limit: 1 })).plans.map((p) => p.plan),
      ["bob-plan"],
    );
    const all = await rpc(endpoint, admin.token, "plan.list", { limit: 1 });
    assert.ok(all.nextCursor);
    assert.ok(
      (await envelope(endpoint, alice.token, "plan.list", { limit: 1, cursor: all.nextCursor })).body.error,
      "a cursor cannot be reused under another ownership scope",
    );
    const mcp = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        authorization: `Bearer ${bob.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "trust_plan_read", arguments: { plan: "alice-plan" } },
      }),
    });
    const mcpBody = await mcp.text();
    assert.match(mcpBody, /denied|forbidden/i);
    assert.doesNotMatch(mcpBody, /rootInputs|ENGAGEMENT CONTEXT/);
    await denied(endpoint, alice.token, "check.attempt.admit", admit(b.checkUris[0]));
    const [aa, ba] = await Promise.all([
      rpc(endpoint, alice.token, "check.attempt.admit", admit(a.checkUris[0])),
      rpc(endpoint, bob.token, "check.attempt.admit", admit(b.checkUris[0])),
    ]);
    const db = container.resolve("database");
    const before = await db.selectFrom("attempts").selectAll().orderBy("attempt_order").execute();
    for (const token of [bob.token, admin.token]) {
      await denied(endpoint, token, "check.attempt.facts", facts(aa));
      await denied(endpoint, token, "check.attempt.finalize", {
        contract: "trust.attempt-finalization-request@1",
        attemptHandle: aa.attemptHandle,
      });
      await denied(endpoint, token, "check.attempt.interrupt", {
        contract: "trust.attempt-interruption-request@1",
        attemptHandle: aa.attemptHandle,
      });
    }
    const batch = facts(aa);
    const trace = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "trust.runner.facts",
                  startTimeUnixNano: "1790384400000000000",
                  attributes: [
                    ["trust.attempt_key", aa.attemptKey],
                    ["trust.attempt_handle", aa.attemptHandle],
                    ["trust.execution_id", aa.executionId],
                    ["trust.check_uri", aa.checkUri],
                  ].map(([key, value]) => ({ key, value: { stringValue: value } })),
                  events: [{ name: "trust.runner.fact", attributes: otlpFactAttributes(batch.facts[0], 0) }],
                },
              ],
            },
          ],
        },
      ],
    };
    const foreignOtlp = await fetch(`${endpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify(trace),
    });
    assert.equal(foreignOtlp.status, 403, "all Plan scope cannot submit another actor's Attempt through OTLP");
    assert.deepEqual(await db.selectFrom("attempts").selectAll().orderBy("attempt_order").execute(), before);
    assert.deepEqual(await db.selectFrom("attempt_fact_receipts").selectAll().execute(), []);
    const refreshed = await oauth.refreshTokenGrant(alice.configuration, alice.refreshToken, {
      resource: DEVELOPMENT_RESOURCE,
    });
    assert.notEqual(refreshed.access_token, alice.token);
    await Promise.all([
      rpc(endpoint, refreshed.access_token, "check.attempt.facts", facts(aa)),
      rpc(endpoint, bob.token, "check.attempt.facts", facts(ba)),
    ]);
    await Promise.all([
      rpc(endpoint, refreshed.access_token, "check.attempt.finalize", {
        contract: "trust.attempt-finalization-request@1",
        attemptHandle: aa.attemptHandle,
      }),
      rpc(endpoint, bob.token, "check.attempt.finalize", {
        contract: "trust.attempt-finalization-request@1",
        attemptHandle: ba.attemptHandle,
      }),
    ]);
    assert.deepEqual(
      (await rpc(endpoint, alice.token, "history.list", {})).snapshots.map((s) => s.plan),
      ["alice-plan"],
    );
    assert.deepEqual(
      (await rpc(endpoint, bob.token, "history.list", {})).snapshots.map((s) => s.plan),
      ["bob-plan"],
    );
    assert.equal((await rpc(endpoint, admin.token, "history.list", {})).snapshots.length, 2);
    const ownCheck = await rpc(endpoint, refreshed.access_token, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri: a.checkUris[0],
    });
    assert.deepEqual(ownCheck.attempts[0].actor, { issuer: provider.issuer, subject: "alice" });
    const narrow = await provider.issue({ subject: "alice", scope: "trust.plan.list.own" });
    assert.equal((await rpc(endpoint, narrow.token, "plan.list", {})).plans.length, 1);
    await denied(endpoint, narrow.token, "plan.read", { plan: "alice-plan" });
    await denied(endpoint, narrow.token, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: aa.attemptHandle,
    });
    const sessionOnly = await provider.issue({ subject: "alice", scope: "trust.session.read.own" });
    assert.equal(
      (await rpc(endpoint, sessionOnly.token, "session.read", { plan: "alice-plan" })).contract,
      "trust.session-view@1",
    );
    await denied(endpoint, sessionOnly.token, "plan.read", { plan: "alice-plan" });
    const finalizeOnly = await provider.issue({ subject: "alice", scope: "trust.check.attempt.finalize.own" });
    const finalization = await rpc(endpoint, finalizeOnly.token, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: aa.attemptHandle,
    });
    assert.equal(finalization.verdict, "VALIDATED");
    assert.deepEqual(finalization.next, { action: "READ_PLAN" });
    const authority = container.resolve("accessService");
    const reader = container.resolve("planReader");
    await assert.rejects(reader.listPlans({}, undefined), { code: "unauthenticated" });
    await assert.rejects(reader.listPlans({}, Object.freeze({ mode: "local" })), { code: "unauthenticated" });
    const verified = await authority.authenticate(`Bearer ${alice.token}`);
    await assert.rejects(reader.listPlans({}, { ...verified }), { code: "unauthenticated" });
    const races = await Promise.all(
      [alice, bob].map((credential) => envelope(endpoint, credential.token, "plan.engage", engage("contested"))),
    );
    assert.equal(races.filter((value) => value.body.result).length, 1);
    assert.equal(races.filter((value) => value.body.error?.code === -32001).length, 1);
    const winningSubject = races[0].body.result ? "alice" : "bob";
    assert.equal(
      (await rpc(endpoint, admin.token, "plan.read", { plan: "contested" })).creator.subject,
      winningSubject,
    );
  } finally {
    await runtime?.close();
    await target.cleanup();
    await provider.close();
  }
});
