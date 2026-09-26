import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccessTestProvider,
  DEVELOPMENT_INTROSPECTION_RESOURCE,
} from "../../../environments/trust-test/auth/provider.mjs";
import { AccessService } from "../dist/src/access/service.js";
import { authorityRuntime, controlledAuthority } from "./access-authority-support.mjs";

test("AUTH-TRANSPORT local JWT and strict introspection validate each protected request", async (t) => {
  const provider = await createAccessTestProvider();
  t.after(() => provider.close());
  const jwt = await authorityRuntime(provider.configuration);
  t.after(() => jwt.close());
  const alice = await provider.issue({ subject: "alice", scope: "trust.environment.list" });
  const bob = await provider.issue({ subject: "bob", scope: "trust.procedure.list" });
  assert.equal((await jwt.rpc(alice.token, "environment.list")).body.result.contract, "trust.environment-catalog@1");
  assert.equal((await jwt.rpc(undefined, "environment.list")).status, 401);
  const denied = await jwt.rpc(bob.token, "environment.list");
  assert.equal(denied.body.error?.code, -32001, JSON.stringify(denied));
  const batchResponse = await fetch(`${jwt.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${alice.token}` },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: "allowed", method: "environment.list", params: {} },
      {
        jsonrpc: "2.0",
        id: "denied",
        method: "environment.save",
        params: { environment: "must-not-exist", values: {} },
      },
    ]),
  });
  const batch = await batchResponse.json();
  assert.equal(batch.find((item) => item.id === "allowed").result.contract, "trust.environment-catalog@1");
  assert.equal(batch.find((item) => item.id === "denied").error.code, -32001);
  assert.equal(await jwt.container.resolve("environmentStore").exists("must-not-exist"), false);
  const mcp = async (token) => {
    const response = await fetch(`${jwt.endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2025-03-26",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "trust_procedure_list", arguments: {} },
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await mcp(alice.token)).result.isError, true);
  assert.notEqual((await mcp(bob.token)).result.isError, true);
  assert.equal((await jwt.rpc(alice.token, "procedure.list")).body.error.code, -32001);
  assert.ok((await jwt.rpc(bob.token, "procedure.list")).body.result);
  const service = jwt.container.resolve("accessService");
  const contexts = await Promise.all([
    service.authenticate(`Bearer ${alice.token}`),
    service.authenticate(`Bearer ${bob.token}`),
  ]);
  assert.equal(service.principal(contexts[0]).subject, "alice");
  assert.equal(service.principal(contexts[1]).subject, "bob");
  assert.ok(
    Object.isFrozen(contexts[0]) && Object.isFrozen(contexts[0].principal) && Object.isFrozen(contexts[0].scopes),
  );
  assert.throws(() => contexts[0].scopes.push("trust.environment.save"), TypeError);
  const parallel = await Promise.all(
    Array.from({ length: 12 }, (_, index) => jwt.rpc(index % 2 ? bob.token : alice.token, "environment.list")),
  );
  parallel.forEach((result, index) => {
    assert.equal(Boolean(result.body.result), index % 2 === 0);
  });

  const online = await authorityRuntime(
    {
      mode: "introspection",
      issuer: provider.issuer,
      audience: provider.configuration.audience,
      allowInsecureLoopback: true,
      introspection: {
        clientId: "trust-introspection",
        clientSecretReference: { environment: "test", name: "introspection" },
        authenticationMethod: "client_secret_post",
      },
    },
    { accessSecretResolver: () => provider.secrets["trust-introspection"] },
  );
  t.after(() => online.close());
  const opaque = await provider.issue({
    subject: "alice",
    scope: "trust.environment.list",
    resource: DEVELOPMENT_INTROSPECTION_RESOURCE,
  });
  assert.equal(
    (await online.rpc(opaque.token, "environment.list")).body.result.contract,
    "trust.environment-catalog@1",
  );
  await provider.revoke(opaque);
  assert.equal((await online.rpc(opaque.token, "environment.list")).status, 401);
  // This provider refuses introspection of its stateless JWT profile: no successful online answer,
  // hence authority-unavailable, never an offline fallback accepting the valid signature.
  assert.equal((await online.rpc(alice.token, "environment.list")).status, 503);

  await t.test("signed negative profiles, cache boundaries, discovery and introspection freshness", async () => {
    const controlled = await controlledAuthority();
    t.after(() => controlled.close());
    let now = Date.now();
    const dependencies = {
      clock: { now: () => new Date(now) },
      accessFetch: fetch,
      accessSecretResolver: () => controlled.secret,
    };
    const verifier = new AccessService({ ...dependencies, accessConfiguration: controlled.configuration });
    const good = await controlled.issue();
    await verifier.authenticate(`Bearer ${good}`);
    for (const input of [
      { claims: { iss: "https://untrusted.example" } },
      { claims: { aud: "another-api" } },
      { claims: { exp: Math.floor(now / 1000) - 1 } },
      { claims: { nbf: Math.floor(now / 1000) + 100 } },
      { claims: { scope: ["trust.environment.list"] } },
      { claims: { sub: "" } },
      { claims: { client_id: undefined } },
      { claims: { jti: undefined } },
      { claims: { jti: 3 } },
      { header: { typ: "JWT" } },
      { claims: { exp: Math.floor(now / 1000) + 1000 } },
    ])
      await assert.rejects(verifier.authenticate(`Bearer ${await controlled.issue(input)}`), {
        code: "unauthenticated",
      });
    const parts = good.split(".");
    parts[2] = `${parts[2][0] === "a" ? "b" : "a"}${parts[2].slice(1)}`;
    await assert.rejects(verifier.authenticate(`Bearer ${parts.join(".")}`), { code: "unauthenticated" });
    await assert.rejects(verifier.authenticate("Basic abc"), { code: "unauthenticated" });
    await controlled.rotate();
    now += 31_000;
    await verifier.authenticate(`Bearer ${await controlled.issue()}`);
    assert.equal(controlled.counts.jwks, 2);
    const requests = controlled.counts.jwks;
    for (let index = 0; index < 4; index++)
      await assert.rejects(
        verifier.authenticate(`Bearer ${await controlled.issue({ header: { kid: `unknown-${index}` } })}`),
        { code: "unauthenticated" },
      );
    assert.equal(controlled.counts.jwks, requests);
    controlled.controls.endpointQuery = true;
    const oauth = new AccessService({
      ...dependencies,
      accessConfiguration: { ...controlled.configuration, discovery: "oauth" },
    });
    await oauth.authenticate(`Bearer ${await controlled.issue()}`);
    controlled.controls.issuerMismatch = true;
    const mismatch = new AccessService({ ...dependencies, accessConfiguration: controlled.configuration });
    await assert.rejects(mismatch.authenticate(`Bearer ${good}`), { code: "authority-unavailable" });
    controlled.controls.issuerMismatch = false;
    const introspection = new AccessService({
      ...dependencies,
      accessConfiguration: controlled.introspectionConfiguration,
    });
    const active = await controlled.issue();
    const before = controlled.counts.introspection;
    const initial = await introspection.authenticate(`Bearer ${active}`);
    introspection.authorize(initial, "environment.list");
    controlled.states.get(active).scope = "";
    const changed = await introspection.authenticate(`Bearer ${active}`);
    assert.throws(() => introspection.authorize(changed, "environment.list"), { code: "forbidden" });
    assert.equal(controlled.counts.introspection, before + 2);
    // This proves consumption of each response, not that any real provider recomputes account roles.
    controlled.controls.unavailable = true;
    await assert.rejects(introspection.authenticate(`Bearer ${active}`), { code: "authority-unavailable" });
    controlled.controls.unavailable = false;
    const original = { ...controlled.states.get(active) };
    for (const invalid of [
      { aud: "another-api" },
      { iss: "https://untrusted.example" },
      { sub: "" },
      { exp: Math.floor(now / 1000) - 1 },
      { scope: ["trust.environment.list"] },
      { active: "true" },
      { token_type: "refresh_token" },
    ]) {
      controlled.states.set(active, { ...original, ...invalid });
      await assert.rejects(introspection.authenticate(`Bearer ${active}`), { code: "unauthenticated" });
    }
    controlled.states.get(active).active = false;
    await assert.rejects(introspection.authenticate(`Bearer ${active}`), { code: "unauthenticated" });
  });
});
