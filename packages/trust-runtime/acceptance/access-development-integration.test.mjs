import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import {
  acquirePackaged,
  assertPrivateOutput,
  createAccessTestProvider,
  engage,
  privateCredential,
  resources,
  root,
  rpc,
  runnerModules,
  runPackaged,
  runtimeFixture,
  scopes,
  seed,
  storageTarget,
  unusedLoopbackCallback,
} from "./access-development-support.mjs";

test("DEV-TRANSPORT lightweight provider and Runner authenticate both RPC and OTLP", { timeout: 120000 }, async () => {
  const provider = await createAccessTestProvider({ runnerRedirectUri: await unusedLoopbackCallback() });
  const target = await storageTarget("pglite");
  const modules = await runnerModules();
  let runtime;
  let outside;
  try {
    runtime = await runtimeFixture(provider, target.storage);
    const acquired = await acquirePackaged(provider, modules, runtime.endpoint, scopes().join(" "));
    const alice = { ...acquired.credential, token: acquired.credential.accessToken };
    const admin = await provider.issue({ subject: "admin", scope: resources.join(" ") });
    await seed(runtime.endpoint, admin.token);
    await rpc(runtime.endpoint, admin.token, "environment.save", {
      environment: "local",
      values: { workspaceRoot: path.dirname(root) },
    });
    const engaged = await rpc(
      runtime.endpoint,
      alice.token,
      "plan.engage",
      engage("runner-live", "git-status", { mode: "live", rootInputs: { repository: path.basename(root) } }),
    );
    const file = acquired.file;
    await modules.module.writeRunnerCredential(file, { ...acquired.credential, expiresAt: 0 });
    const result = await runPackaged(runtime.endpoint, file, engaged.checkUris[0]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.result.result.status, "COMPLETED");
    assert.equal(result.result.result.qualification.verdict, "VALIDATED");
    assertPrivateOutput(result, [alice]);
    const refreshed = await modules.module.readRunnerCredential(file);
    assert.notEqual(
      refreshed.accessToken,
      alice.accessToken,
      "Actual packaged Runner must refresh the CLI-acquired credential",
    );
    assertPrivateOutput(result, [refreshed]);
    assertPrivateOutput(acquired, [refreshed]);
    assert.equal(
      (await rpc(runtime.endpoint, refreshed.accessToken, "plan.read", { plan: "runner-live" })).creator.subject,
      "alice",
      "Refresh preserves the original principal",
    );
    const view = await rpc(runtime.endpoint, alice.token, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri: engaged.checkUris[0],
    });
    assert.equal(view.attempts[0].actor.subject, "alice");
    const db = runtime.container.resolve("database");
    assert.ok(
      (await db.selectFrom("attempt_fact_receipts").selectAll().execute()).length > 0,
      "Real OTLP facts must persist",
    );
    const shell = await modules.module.runShell(
      {
        executable: process.execPath,
        arguments: [
          { kind: "literal", value: "-e" },
          {
            kind: "literal",
            value: 'process.stdout.write(String(Object.keys(process.env).some(k=>k.startsWith("TRUST_"))))',
          },
        ],
        cwd: { environment: "directory" },
        acceptedExits: [{ code: 0 }],
      },
      {},
      { directory: modules.directory },
      { id: "privacy" },
      undefined,
      {
        processEnvironment: {
          PATH: process.env.PATH,
          TRUST_AUTH_FILE: file,
          TRUST_ACCESS_TOKEN: alice.accessToken,
          TRUST_REFRESH_TOKEN: alice.refreshToken,
        },
      },
    );
    assert.equal(shell.stdout, "false", "External Shell cannot inherit Runner credential variables");
    const observed = [];
    outside = createServer((request, response) => {
      observed.push({ url: request.url, authorization: request.headers.authorization });
      if (request.url === "/rpc") {
        response.writeHead(302, { location: "/escaped" }).end();
      } else response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise((resolve) => outside.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${outside.address().port}`;
    await modules.module.runHttp(
      { method: "GET", url: { environment: "base" }, path: [], query: [], headers: [], format: "json" },
      {},
      { base: origin },
      {},
      { id: "external" },
    );
    assert.equal(observed[0].authorization, undefined, "External HTTP never receives Runner bearer");
    const other = await privateCredential(modules, origin, alice, "redirect.json");
    const auth = modules.module.createRunnerAuthorization(
      { TRUST_AUTH_FILE: other },
      `${origin}/rpc`,
      `${origin}/v1/traces`,
    );
    await assert.rejects(
      new modules.module.CheckClient(`${origin}/rpc`, 1000, auth).admit("key", engaged.checkUris[0]),
      /HTTP 302/,
    );
    assert.ok(!observed.some((row) => row.url === "/escaped"), "Bearer redirects must not be followed");
  } finally {
    if (outside) {
      outside.closeAllConnections();
      await new Promise((resolve) => outside.close(resolve));
    }
    await runtime?.close();
    await target.cleanup();
    await modules.cleanup();
    await provider.close();
  }
});
