import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startRuntime } from "../dist/src/server.js";
import { runnerModules } from "./access-development-support.mjs";

test("a private development service credential renews Runner Bearer access through the runtime", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-dev-runner-"));
  const modules = await runnerModules();
  const secret = randomBytes(32).toString("base64url");
  const serviceSecretFile = path.join(directory, "runner.secret");
  const credentialFile = path.join(modules.directory, "runner.json");
  const tailnetOrigin = "https://trust-dev.example.ts.net:18447";
  let runtime;
  try {
    await writeFile(serviceSecretFile, secret + "\n", { mode: 0o600 });
    runtime = await startRuntime({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "db") },
      accessConfiguration: {
        mode: "local-jwt",
        issuer: `${tailnetOrigin}/auth/dev`,
        audience: "urn:trust:runtime",
        algorithms: ["RS256"],
        tokenProfile: { headerType: "at+jwt" },
        maxTokenAgeSeconds: 120,
      },
      developmentAuthentication: {
        tailnetOrigin,
        users: [],
        local: { subject: "developer", scopes: [], codeFile: path.join(directory, "code.json") },
        services: [
          {
            clientId: "trust-runner",
            subject: "developer-runner",
            scopes: ["trust.plan.list.own"],
            secretFile: serviceSecretFile,
          },
        ],
      },
    });
    const origin = `http://127.0.0.1:${runtime.port}`;
    await writeFile(
      credentialFile,
      JSON.stringify({
        version: 2,
        mode: "development-service",
        origin,
        clientId: "trust-runner",
        clientSecret: secret,
      }),
      { mode: 0o600 },
    );
    const authorization = modules.module.createRunnerAuthorization(
      { TRUST_AUTH_FILE: credentialFile },
      `${origin}/rpc`,
      `${origin}/v1/traces`,
    );
    assert.ok(authorization);
    const headers = await authorization.headers(`${origin}/rpc`);
    assert.match(headers.authorization, /^Bearer /);
    const response = await fetch(`${origin}/rpc`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plan.list", params: {} }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(await authorization.headers(`${origin}/v1/traces`), headers);
    await assert.rejects(authorization.headers(`${origin}/mcp`), /restricted/);
    await writeFile(
      credentialFile,
      JSON.stringify({
        version: 2,
        mode: "development-service",
        origin,
        clientId: "trust-runner",
        clientSecret: "a".repeat(40),
      }),
      { mode: 0o600 },
    );
    const invalid = modules.module.createRunnerAuthorization(
      { TRUST_AUTH_FILE: credentialFile },
      `${origin}/rpc`,
      `${origin}/v1/traces`,
    );
    await assert.rejects(invalid.headers(`${origin}/rpc`), /authentication failed/);
  } finally {
    await runtime?.close();
    await modules.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
