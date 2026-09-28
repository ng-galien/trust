import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccessTestProvider, DEVELOPMENT_SCOPES } from "../../../environments/trust-test/auth/provider.mjs";
import { startRuntime } from "../dist/src/server.js";
import { root, rpc, scopes } from "./access-ownership-support.mjs";

test("extension Plan declarations retain principal, environment, revision and closed-role authority", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-declarations-"));
  const provider = await createAccessTestProvider();
  let runtime;
  try {
    await writeFile(
      path.join(directory, "server.mjs"),
      "export const createExtension=()=>({async prepare(){},async start(){},async stop(){},async read(){return {status:200,body:{}};}});",
    );
    const installations = [];
    for (const id of ["dragon-heist", "coordination"]) {
      const manifest = path.join(directory, `${id}.json`);
      await writeFile(
        manifest,
        JSON.stringify({
          contract: "trust.extension@1",
          id,
          title: "Public acceptance",
          version: "1.0.0",
          server: "./server.mjs",
          configuration: {},
          requestedCapabilities: ["plans.read", "plans.declare"],
        }),
      );
      installations.push({
        manifest,
        configuration: {},
        environment: "local",
        grants: id === "dragon-heist" ? ["plans.read", "plans.declare"] : ["plans.read"],
        autoStart: true,
      });
    }
    const registry = path.join(directory, "extensions.json");
    await writeFile(registry, JSON.stringify({ extensions: installations }));
    runtime = await startRuntime({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "data") },
      extensionsFile: registry,
      operationsDirectory: path.join(root, "assets/operations"),
      accessConfiguration: provider.configuration,
    });
    const endpoint = `http://127.0.0.1:${runtime.port}`;
    const admin = await provider.issue({ subject: "admin", scope: DEVELOPMENT_SCOPES.join(" ") });
    const alice = await provider.issue({
      subject: "alice",
      scope: [...scopes(), "trust.extension.dragon-heist.use", "trust.extension.coordination.use"].join(" "),
    });
    const bob = await provider.issue({
      subject: "bob",
      scope: [...scopes(), "trust.extension.dragon-heist.use"].join(" "),
    });
    const noWrite = await provider.issue({
      subject: "alice",
      scope: ["trust.plan.read.own", "trust.extension.dragon-heist.use"].join(" "),
    });
    const noExtension = await provider.issue({ subject: "alice", scope: scopes().join(" ") });
    await rpc(endpoint, admin.token, "procedure.publish", {
      source: await readFile(
        path.join(root, "packages/trust-runtime/acceptance/fixtures/optional-agent-declarations.feature"),
        "utf8",
      ),
    });
    for (const environment of ["local", "foreign"]) {
      await rpc(endpoint, admin.token, "environment.save", { environment, values: { workspaceRoot: root } });
      await rpc(endpoint, alice.token, "plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: "optional-agent-declarations",
        procedureVersion: "1.0.0",
        plan: `input-${environment}`,
        environment,
        rootInputs: { workspace: "." },
      });
    }
    const send = async (
      token,
      {
        extension = "dragon-heist",
        plan = "input-local",
        expectedRevision = 1,
        declarations = { "required note": "From a form" },
        ...extra
      } = {},
    ) => {
      const response = await fetch(`${endpoint}/extensions/${extension}/trust/plans/${plan}/declarations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          contract: "trust.plan-declaration-replacement-request@1",
          plan,
          expectedRevision,
          declarations,
          ...extra,
        }),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await send(undefined)).status, 401);
    assert.equal((await send(bob.token)).status, 403);
    assert.equal((await send(noWrite.token)).status, 403);
    assert.equal((await send(noExtension.token)).status, 403);
    assert.equal((await send(alice.token, { extension: "coordination" })).status, 403);
    assert.equal((await send(alice.token, { plan: "input-foreign" })).status, 404);
    assert.equal((await send(alice.token, { plan: "missing" })).status, 404);
    assert.equal((await send(alice.token, { declarations: { workspace: "replacement" } })).status, 400);
    assert.equal((await send(alice.token, { facts: [] })).status, 400);
    const accepted = await send(alice.token);
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    assert.equal((await send(alice.token)).status, 409);
    const plan = await rpc(endpoint, alice.token, "plan.read", { plan: "input-local" });
    assert.deepEqual(plan.declarations, { "required note": "From a form" });
    assert.equal(plan.satisfiedChecks, 0);
    assert.deepEqual(plan.rootInputs, { workspace: "." });
  } finally {
    await runtime?.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
