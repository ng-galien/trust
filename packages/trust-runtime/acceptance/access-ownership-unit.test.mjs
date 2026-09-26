import assert from "node:assert/strict";
import test from "node:test";
import { accessPlanScope, authorizeAccess, samePrincipal } from "../dist/src/access/policy.js";

test("PLAN-POLICY principal equality and token refresh preserve ownership", () => {
  const creator = Object.freeze({ issuer: "https://identity.example/realm", subject: "alice" });
  const context = (principal, scopes, clientId = "workstation-a") =>
    Object.freeze({
      mode: "authenticated",
      principal: Object.freeze({ ...principal }),
      clientId,
      scopes: Object.freeze(scopes),
      expiresAt: 2000000300,
      verifiedAt: 2000000000,
      verification: "local-jwt",
    });
  const first = context(creator, ["trust.plan.read.own", "trust.check.attempt.facts.own"]);
  const refreshed = context(creator, [...first.scopes], "workstation-b");
  for (const access of [first, refreshed]) {
    assert.equal(samePrincipal(access.principal, creator), true);
    assert.equal(accessPlanScope(access, "plan.read"), "own");
    assert.doesNotThrow(() => authorizeAccess(access, "plan.read", creator));
    assert.doesNotThrow(() => authorizeAccess(access, "check.attempt.facts", creator));
    assert.throws(() => authorizeAccess(access, "plan.close", creator), { code: "forbidden" });
    assert.throws(() => authorizeAccess(access, "plan.read", null), { code: "forbidden" });
  }
  for (const foreign of [
    { ...creator, subject: "bob" },
    { ...creator, issuer: "https://other.example/realm" },
    { ...creator, subject: "Alice" },
  ]) {
    assert.equal(samePrincipal(creator, foreign), false);
    assert.throws(() => authorizeAccess(first, "plan.read", foreign), { code: "forbidden" });
  }
  assert.equal(samePrincipal(null, null), false);
  const stripped = context(creator, []);
  assert.throws(() => authorizeAccess(stripped, "plan.read", creator), { code: "forbidden" });
  const broad = context({ ...creator, subject: "reviewer" }, ["trust.plan.read.all"]);
  assert.equal(accessPlanScope(broad, "plan.read"), "all");
  assert.doesNotThrow(() => authorizeAccess(broad, "plan.read", creator));
  assert.doesNotThrow(() => authorizeAccess(broad, "plan.read", null));
  assert.throws(() => authorizeAccess(broad, "plan.remove", creator), { code: "forbidden" });
  assert.throws(() => authorizeAccess(first, "plan.unknown", creator), { code: "forbidden" });
  // This layer tests the fixed policy only. Shared authority provenance and signatures
  // are exercised through real authentication in the integration/database journeys.
});
