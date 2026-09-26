import assert from "node:assert/strict";
import { chmod, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as oauth from "openid-client";
import {
  createAccessTestProvider,
  DEVELOPMENT_INTROSPECTION_RESOURCE,
  privateCredential,
  runnerModules,
} from "./access-development-support.mjs";

test("DEV-TOKEN signed development tokens and private credential handling", { timeout: 120000 }, async () => {
  const provider = await createAccessTestProvider();
  const modules = await runnerModules();
  try {
    const credential = await provider.issue({ scope: "trust.plan.read.own" });
    const jwks = createRemoteJWKSet(new URL(provider.jwksUri));
    const verified = await jwtVerify(credential.accessToken, jwks, {
      issuer: provider.issuer,
      audience: "urn:trust:runtime",
      typ: "at+jwt",
    });
    assert.equal(verified.payload.sub, "alice");
    assert.equal(verified.payload.scope, "trust.plan.read.own");
    await assert.rejects(jwtVerify(`${credential.accessToken.slice(0, -12)}aaaaaaaaaaaa`, jwks));
    await assert.rejects(provider.issue({ subject: "unconfigured" }));
    await assert.rejects(provider.issue({ subject: "alice", scope: "trust.plan.read.all" }));
    const opaque = await provider.issue({ resource: DEVELOPMENT_INTROSPECTION_RESOURCE, scope: "trust.plan.read.own" });
    assert.equal((await provider.introspect(opaque.accessToken)).active, true);
    await provider.revoke(opaque);
    assert.equal((await provider.introspect(opaque.accessToken)).active, false);
    await assert.rejects(
      oauth.refreshTokenGrant(opaque.configuration, opaque.refreshToken, { resource: opaque.resource }),
    );
    const endpoint = "http://127.0.0.1:4530";
    const file = await privateCredential(modules, endpoint, { ...credential, expiresAt: 0 });
    const authorization = modules.module.createRunnerAuthorization(
      { TRUST_AUTH_FILE: file },
      `${endpoint}/rpc`,
      `${endpoint}/v1/traces`,
    );
    const [rpc, otlp] = await Promise.all([
      authorization.headers(`${endpoint}/rpc`),
      authorization.headers(`${endpoint}/v1/traces`),
    ]);
    assert.equal(rpc.authorization, otlp.authorization);
    assert.notEqual(rpc.authorization, `Bearer ${credential.accessToken}`);
    const refreshed = await modules.module.readRunnerCredential(file);
    assert.equal((await jwtVerify(refreshed.accessToken, jwks)).payload.sub, "alice");
    await assert.rejects(authorization.headers("http://127.0.0.1:4531/rpc"));
    assert.throws(() =>
      modules.module.createRunnerAuthorization(
        { TRUST_AUTH_FILE: file },
        `${endpoint}/rpc`,
        "http://127.0.0.1:4531/v1/traces",
      ),
    );
    assert.throws(() =>
      modules.module.createRunnerAuthorization(
        { TRUST_ACCESS_TOKEN: credential.accessToken },
        `${endpoint}/rpc`,
        `${endpoint}/v1/traces`,
      ),
    );
    await chmod(file, 0o644);
    await assert.rejects(modules.module.readRunnerCredential(file));
    await chmod(file, 0o600);
    const link = path.join(modules.directory, "link.json");
    await symlink(file, link);
    await assert.rejects(modules.module.readRunnerCredential(link));
  } finally {
    await modules.cleanup();
    await provider.close();
  }
});
