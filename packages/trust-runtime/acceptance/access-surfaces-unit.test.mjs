import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTrustConfiguration, parseAuthenticationConfiguration } from "@trust/extension-sdk";

const authenticationFromEnvironment = async (environment) =>
  (
    await loadTrustConfiguration({
      environment,
      mode: "runtime",
      resolvePath: path.resolve,
      readJson: async (file) => JSON.parse(await readFile(file, "utf8")),
    })
  ).configuration.authentication;

test("SURFACE-CONFIG invalid and secret-bearing configuration is refused", async () => {
  const valid = {
    profile: "shared",
    resourceUrl: "https://trust.example/mcp",
    access: { mode: "local-jwt", issuer: "https://identity.example", audience: "trust" },
    browser: {
      issuer: "https://identity.example",
      clientId: "browser",
      redirectUri: "https://trust.example/auth/callback",
      postLogoutRedirectUri: "https://trust.example/",
      scope: "openid trust.plan.read.own",
    },
  };
  assert.equal(parseAuthenticationConfiguration(valid).access.mode, "local-jwt");
  for (const candidate of [
    { ...valid, access: { mode: "local" } },
    { ...valid, profile: "invalid" },
    { ...valid, access: { ...valid.access, allowInsecureLoopback: true } },
    { ...valid, browser: { ...valid.browser, clientSecret: "never-accept" } },
    { ...valid, browser: { ...valid.browser, issuer: "https://attacker.example" } },
    { ...valid, browser: { ...valid.browser, postLogoutRedirectUri: "https://attacker.example" } },
    {
      ...valid,
      access: {
        ...valid.access,
        mode: "introspection",
        introspection: { clientId: "server", clientSecret: "never-accept" },
      },
    },
  ])
    assert.throws(() => parseAuthenticationConfiguration(candidate));
  const directory = await mkdtemp(path.join(tmpdir(), "trust-auth-config-"));
  try {
    const file = path.join(directory, "auth.json");
    await writeFile(file, JSON.stringify({ authentication: valid }));
    assert.equal(
      (await authenticationFromEnvironment({ TRUST_CONFIG_FILE: file })).access.mode,
      "local-jwt",
      "canonical configuration selects the authentication section",
    );
    await assert.rejects(authenticationFromEnvironment({ TRUST_CONFIG_FILE: "relative.json" }));
    await writeFile(file, '{"password":"unclosed-secret');
    await assert.rejects(
      authenticationFromEnvironment({ TRUST_CONFIG_FILE: file }),
      (error) => !error.message.includes("unclosed-secret"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
