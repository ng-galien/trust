import assert from "node:assert/strict";
import test from "node:test";
import { extensionUseScope } from "@trust/extension-sdk";
import { authorizeAccess } from "../dist/src/access/policy.js";
import { AccessService } from "../dist/src/access/service.js";
import { extensionInvocation, parseExtensionInvocation } from "../dist/src/extensions/access.js";

test("EXTENSION-ACCESS closed actions and trusted context refuse forged authority", () => {
  const principal = { issuer: "https://issuer.example", subject: "alice" };
  const access = {
    mode: "authenticated",
    principal,
    scopes: [extensionUseScope("coordination")],
    expiresAt: Date.now() / 1000 + 120,
    verifiedAt: Date.now() / 1000,
    verification: "local-jwt",
  };
  authorizeAccess(access, "extension.coordination.use");
  for (const action of [
    "extension.mobile-companion.use",
    "extension.start",
    "credential.list",
    "procedure.publish",
    "plan.read",
    "plan.remove",
    "extension.*.use",
    "extension.coordination.use.extra",
  ])
    assert.throws(() => authorizeAccess(access, action), { code: "forbidden" });
  for (const value of ["*", "coordination.use", "Coordination", "../coordination", ""])
    assert.throws(() => extensionUseScope(value));
  for (const scopes of [
    ["trust.extension.*.use"],
    ["trust.extension.coordination"],
    ["trust.extension.coordination.use.all"],
    ["trust.extension.coordination.missions.list.own"],
  ])
    assert.throws(() => authorizeAccess({ ...access, scopes }, "extension.coordination.use"), { code: "forbidden" });
  const dependencies = {
    clock: { now: () => new Date() },
    accessFetch: async () => {
      throw new Error("Unexpected fetch");
    },
    accessSecretResolver: () => undefined,
  };
  const authority = new AccessService({
    ...dependencies,
    accessConfiguration: { mode: "local-jwt", issuer: principal.issuer, audience: "trust" },
  });
  for (const forged of [undefined, { mode: "local" }, access, { ...access }, null])
    assert.throws(() => extensionInvocation(authority, "coordination", forged), { code: "unauthenticated" });
  const local = new AccessService({ ...dependencies, accessConfiguration: { mode: "local" } });
  assert.deepEqual(extensionInvocation(local, "coordination", undefined), { mode: "local" });
  const projection = {
    mode: "authenticated",
    principal,
    extensionId: "coordination",
    expiresAt: Date.now() / 1000 + 120,
  };
  const parsed = parseExtensionInvocation(projection, "coordination");
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.principal));
  for (const invalid of [
    undefined,
    { ...projection, extensionId: "mobile-companion" },
    { ...projection, expiresAt: 0 },
    { ...projection, authorization: "Bearer forbidden" },
    { mode: "local", principal },
  ])
    assert.throws(() => parseExtensionInvocation(invalid, "coordination"));
  assert.throws(
    () => authority.authorizeExtension(parsed, "coordination"),
    { code: "unauthenticated" },
    "an IPC projection cannot become server authority",
  );
});
