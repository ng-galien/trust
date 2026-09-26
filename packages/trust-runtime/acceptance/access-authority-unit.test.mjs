import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessConfiguration } from "@trust/extension-sdk";
import { accessPlanScope, authorizeAccess, samePrincipal } from "../dist/src/access/policy.js";
import { AccessService } from "../dist/src/access/service.js";

test("AUTH-POLICY exact actions and own scope deny missing or foreign authority", async (t) => {
  const alice = { issuer: "https://issuer.example", subject: "alice" };
  const bob = { ...alice, subject: "bob" };
  const context = (scopes, principal = alice) =>
    Object.freeze({
      mode: "authenticated",
      principal: Object.freeze(principal),
      scopes: Object.freeze(scopes),
      expiresAt: 2000,
      verifiedAt: 1000,
      verification: "local-jwt",
    });
  const forbidden = (call) => assert.throws(call, { code: "forbidden", status: 403 });
  await t.test("own is exact principal plus exact action, never owner privilege", () => {
    const own = context(["trust.plan.read.own"]);
    authorizeAccess(own, "plan.read", alice);
    assert.equal(accessPlanScope(own, "plan.read"), "own");
    forbidden(() => authorizeAccess(context([]), "plan.read", alice));
    forbidden(() => authorizeAccess(own, "plan.read", bob));
    forbidden(() => authorizeAccess(own, "plan.read", { ...alice, issuer: "https://other.example" }));
    forbidden(() => authorizeAccess(own, "plan.read", null));
    forbidden(() => authorizeAccess(own, "plan.remove", alice));
    assert.equal(samePrincipal(alice, { ...alice }), true);
    assert.equal(samePrincipal(null, null), false);
  });
  await t.test("all only removes creator equality for the granted action", () => {
    const all = context(["trust.plan.read.all"]);
    authorizeAccess(all, "plan.read", bob);
    authorizeAccess(all, "plan.read", null);
    forbidden(() => authorizeAccess(all, "plan.remove", bob));
    forbidden(() =>
      authorizeAccess(context(["trust.plan.*", "trust.plan.read", "trust.plan.read.all.extra"]), "plan.read", alice),
    );
    forbidden(() => authorizeAccess(context(["trust.unknown.all"]), "unknown", alice));
  });
  await t.test("resource permissions do not inherit Plan scopes or token unions", () => {
    authorizeAccess(context(["trust.procedure.publish"]), "procedure.publish");
    forbidden(() => authorizeAccess(context(["trust.procedure.publish.all"]), "procedure.publish"));
    const refreshed = context(["trust.plan.list.own"]);
    forbidden(() => authorizeAccess(refreshed, "plan.read", alice));
    authorizeAccess(context(["trust.plan.read.own"]), "plan.read", alice);
  });
  await t.test("shared service rejects forged, local and absent contexts before policy", () => {
    const authority = new AccessService({
      accessConfiguration: { mode: "local-jwt", issuer: alice.issuer, audience: "trust" },
      clock: { now: () => new Date(1000_000) },
      accessFetch: async () => {
        throw new Error("Unexpected fetch");
      },
      accessSecretResolver: () => undefined,
    });
    for (const forged of [undefined, { mode: "local" }, context(["trust.plan.read.all"]), {}, null]) {
      assert.throws(() => authority.authorize(forged, "plan.read", alice), { code: "unauthenticated", status: 401 });
    }
    assert.equal(authority.shared, true);
  });
  await t.test("configuration is strict and local mode is explicitly distinct", async () => {
    assert.throws(() => parseAccessConfiguration({ mode: "typo" }));
    assert.throws(() => parseAccessConfiguration({ mode: "local", issuer: alice.issuer }));
    assert.throws(() =>
      parseAccessConfiguration({
        mode: "local-jwt",
        issuer: "http://remote.example",
        audience: "trust",
        allowInsecureLoopback: true,
      }),
    );
    assert.throws(() =>
      parseAccessConfiguration({ mode: "local-jwt", issuer: alice.issuer, audience: "trust", algorithms: ["HS256"] }),
    );
    assert.throws(() =>
      parseAccessConfiguration({
        mode: "local-jwt",
        issuer: alice.issuer,
        audience: "trust",
        tokenProfile: { headerType: "JWT" },
      }),
    );
    assert.throws(() =>
      parseAccessConfiguration({
        mode: "introspection",
        issuer: alice.issuer,
        audience: "trust",
        introspection: { clientId: "trust", clientSecret: "not-allowed" },
      }),
    );
    const authority = new AccessService({
      accessConfiguration: { mode: "local" },
      clock: { now: () => new Date() },
      accessFetch: async () => {
        throw new Error("Unexpected fetch");
      },
      accessSecretResolver: () => undefined,
    });
    assert.equal(authority.shared, false);
    assert.equal(authority.principal(undefined), null);
    assert.deepEqual(await authority.authenticate(undefined), { mode: "local" });
    authority.authorize(undefined, "existing.local.extension.command");
  });
});
