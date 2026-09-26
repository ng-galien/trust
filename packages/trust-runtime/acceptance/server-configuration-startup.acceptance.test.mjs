import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { command, freePort, root, setupConfiguration } from "./server-configuration-support.mjs";

test("CONFIG-STARTUP real server validates file and environment configuration", { timeout: 120000 }, async () => {
  const fixture = await setupConfiguration({
    server: { semanticAuthority: "public.example:443", sessionDurationMs: 9000 },
    logging: { level: "warn" },
    runner: { shellTimeoutMs: 5000, additionalPath: ["/file-bin"] },
  });
  try {
    const env = { TRUST_CONFIG_FILE: fixture.file, TRUST_SESSION_DURATION_MS: "12000" };
    const view = await command(["server", "config"], env);
    assert.equal(view.code, 0, view.stderr);
    const effective = JSON.parse(view.stdout);
    assert.equal(effective.configuration.server.sessionDurationMs, 12000);
    assert.equal(effective.sources["server.sessionDurationMs"], "environment");
    assert.equal(effective.sources["server.semanticAuthority"], "file");
    assert.equal(effective.configuration.logging.level, "warn");
    assert.equal(effective.sources["server.trialTimeoutMs"], "default");
    const server = await fixture.start({ TRUST_SESSION_DURATION_MS: "12000" });
    assert.equal((await fetch(`${server.endpoint}/health`)).status, 200);
    await access(path.join(fixture.configuration.server.stateDirectory, "operations/git.head-read.feature"));
    await fixture.stop();
    const saved = await readFile(fixture.file, "utf8");
    for (const override of [
      { TRUST_PORT: "junk" },
      { TRUST_SEMANTIC_AUTHORITY: "Uppercase.example:443" },
      { TRUST_SEMANTIC_AUTHORITY: "canonical.example:0443" },
      { TRUST_SEMANTIC_AUTHORITY: "canonical.example:65536" },
      { TRUST_SESSION_DURATION_MS: "10ms" },
      { TRUST_SHELL_TIMEOUT_MS: "12bad" },
      { TRUST_TRIAL_TIMEOUT_MS: "2147483648" },
      { TRUST_SESSION_DURATION_MS: "9007199254740991" },
      { TRUST_AUTH_CONFIG_FILE: fixture.file },
      { TRUST_DATABASE_PATH: "retained.sqlite" },
    ]) {
      const result = await command(["server", "start"], { ...env, ...override });
      assert.notEqual(result.code, 0);
      assert.doesNotMatch(result.stdout, /running at/);
    }
    for (const invalid of [
      { ...fixture.configuration, unknown: true },
      { ...fixture.configuration, server: { ...fixture.configuration.server, sessionDurationMs: -1 } },
      { ...fixture.configuration, authentication: { profile: "shared", access: { mode: "local" } } },
    ]) {
      await writeFile(fixture.file, JSON.stringify(invalid));
      const result = await command(["server", "start"], { TRUST_CONFIG_FILE: fixture.file });
      assert.notEqual(result.code, 0, result.stdout);
    }
    await writeFile(
      fixture.file,
      JSON.stringify({
        ...fixture.configuration,
        storage: { kind: "postgresql", connectionString: "postgresql://operator:secret-marker@localhost/example" },
        shell: { webAccessPassword: "private-web-password-marker" },
      }),
    );
    const redacted = await command(["server", "config"], { TRUST_CONFIG_FILE: fixture.file });
    assert.equal(redacted.code, 0, redacted.stderr);
    assert.doesNotMatch(redacted.stdout + redacted.stderr, /secret-marker|private-web-password-marker/);
    assert.match(redacted.stdout, /redacted/);
    for (const malformed of [
      { server: { semanticAuthority: "[malformed-private-url-marker" } },
      {
        authentication: {
          profile: "shared",
          resourceUrl: "malformed-private-url-marker",
          access: { mode: "local-jwt", issuer: "https://identity.example", audience: "trust" },
        },
      },
    ]) {
      await writeFile(fixture.file, JSON.stringify({ ...fixture.configuration, ...malformed }));
      const result = await command(["server", "config"], { TRUST_CONFIG_FILE: fixture.file });
      assert.notEqual(result.code, 0);
      assert.doesNotMatch(result.stdout + result.stderr, /malformed-private-url-marker/);
    }
    await writeFile(fixture.file, JSON.stringify({ ...fixture.configuration, storage: { kind: "pglite" } }));
    await mkdir(fixture.configuration.server.stateDirectory, { recursive: true });
    await writeFile(path.join(fixture.configuration.server.stateDirectory, "runtime.sqlite"), "retained-sentinel");
    const retained = await command(["server", "start"], { TRUST_CONFIG_FILE: fixture.file });
    assert.notEqual(retained.code, 0);
    assert.match(retained.stderr, /Retained SQLite/);
    await assert.rejects(access(path.join(fixture.configuration.server.stateDirectory, "pglite")));
    assert.equal(
      await readFile(path.join(fixture.configuration.server.stateDirectory, "runtime.sqlite"), "utf8"),
      "retained-sentinel",
    );
    await writeFile(fixture.file, saved);
    const runner = await command(
      ["--print-config"],
      {
        TRUST_CONFIG_FILE: fixture.file,
        TRUST_RPC_ENDPOINT: "https://configured.example/rpc",
        TRUST_RUNNER_ADDITIONAL_PATH: JSON.stringify(["/environment-bin"]),
      },
      path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"),
    );
    assert.equal(runner.code, 0, runner.stderr);
    assert.equal(JSON.parse(runner.stdout).configuration.runner.rpcEndpoint, "https://configured.example/rpc");
    assert.equal(JSON.parse(runner.stdout).configuration.runner.shellTimeoutMs, 5000);
    assert.deepEqual(JSON.parse(runner.stdout).configuration.runner.additionalPath, ["/environment-bin"]);
    assert.equal(JSON.parse(runner.stdout).sources["runner.additionalPath"], "environment");
    const withoutAuthority = JSON.parse(saved);
    delete withoutAuthority.server.semanticAuthority;
    await writeFile(fixture.file, JSON.stringify(withoutAuthority));
    const implicitIpv6 = await command(["server", "start"], { TRUST_CONFIG_FILE: fixture.file, TRUST_HOST: "::1" });
    assert.notEqual(implicitIpv6.code, 0);
    assert.match(implicitIpv6.stderr, /IPv6 bind requires explicit server.semanticAuthority/);
    await writeFile(fixture.file, saved);
    const ipv6 = await fixture.start({ TRUST_HOST: "::1" });
    assert.equal((await fetch(`${ipv6.endpoint}/health`)).status, 200);
    await fixture.stop();
    const runtime = await command(
      ["--print-config"],
      { TRUST_CONFIG_FILE: fixture.file, TRUST_PORT: "0" },
      path.join(root, "packages/trust-runtime/dist/src/index.js"),
    );
    assert.equal(runtime.code, 0, runtime.stderr);
    assert.equal(JSON.parse(runtime.stdout).configuration.server.semanticAuthority, "public.example:443");
  } finally {
    await fixture.close();
  }
});
