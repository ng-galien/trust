import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { chart, root, temporary, helmEnvironment, render, prepareRuntime, rpc, rm } from "./support.mjs";
import { seed, engage } from "../../../packages/trust-runtime/acceptance/access-ownership-support.mjs";
import { command } from "../../../packages/trust-runtime/acceptance/server-configuration-support.mjs";

test("HELM-FIXED example renders canonical fixed configuration and refuses incompatible settings", async () => {
  const directory = await temporary();
  try {
    const file = path.join(chart, "examples/fixed-values.yaml");
    const values = parse(await readFile(file, "utf8"));
    execFileSync("helm", ["lint", chart, "--strict", "-f", file], { env: await helmEnvironment(directory), stdio: "pipe" });
    const documents = await render(directory, values);
    const authentication = JSON.parse(documents.find((item) => item.kind === "ConfigMap").data["trust.json"]).authentication;
    assert.deepEqual(Object.keys(authentication).sort(), ["access", "profile"]);
    assert.equal(authentication.profile, "fixed");
    assert.deepEqual(Object.keys(authentication.access).sort(), ["allowedOrigins", "issuer", "mode", "scopes", "subject"]);
    assert.deepEqual(authentication.access.scopes, values.config.authentication.access.scopes);
    for (const change of [
      { subject: null }, { scopes: null }, { roles: ["admin"] }, { audience: "leftover" },
    ]) {
      await assert.rejects(render(directory, { config: { authentication: {
        ...values.config.authentication, access: { ...values.config.authentication.access, ...change },
      } } }));
    }
    await assert.rejects(render(directory, { config: { authentication: { ...values.config.authentication, profile: "shared" } } }));
    await assert.rejects(render(directory, { config: { authentication: { ...values.config.authentication, resourceUrl: "https://trust.example.com/mcp" } } }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HELM-FIXED rendered server and packaged Runner work without an identity provider", { timeout: 90000 }, async () => {
  const directory = await temporary();
  let runtime;
  try {
    const values = parse(await readFile(path.join(chart, "examples/fixed-values.yaml"), "utf8"));
    const authentication = values.config.authentication;
    authentication.access.scopes.push("trust.procedure.publish", "trust.procedure.read", "trust.environment.save", "trust.plan.engage.own");
    runtime = await prepareRuntime(directory, { authentication });
    assert.equal(runtime.identity, undefined, "No identity provider is created for fixed access");
    assert.equal(runtime.environment.TRUST_AUTH_FILE, undefined);
    await runtime.start();
    assert.deepEqual(await (await fetch(runtime.endpoint + "/auth/config")).json(), { required: false, browser: null });
    assert.match(await (await fetch(runtime.endpoint)).text(), /<title>TRUST<\/title>/);
    await seed(runtime.endpoint);
    await rpc(runtime, "environment.save", { environment: "local", values: { workspaceRoot: path.dirname(root) } });
    const plan = await rpc(runtime, "plan.engage", engage("helm-fixed-runner", "git-status", {
      mode: "live", rootInputs: { repository: path.basename(root) },
    }));
    const result = await command([plan.checkUris[0], "--json"], {
      TRUST_RPC_ENDPOINT: runtime.endpoint + "/rpc", TRUST_OTLP_ENDPOINT: runtime.endpoint + "/v1/traces",
    }, path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"));
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const run = JSON.parse(result.stdout);
    assert.equal(run.result.status, "COMPLETED");
    assert.equal(run.result.qualification.verdict, "VALIDATED");
    const persisted = await rpc(runtime, "plan.read", { plan: "helm-fixed-runner" });
    assert.deepEqual(persisted.creator, { issuer: authentication.access.issuer, subject: authentication.access.subject });
    assert.equal(persisted.workState, "COMPLETE");
    assert.equal(persisted.checklistComplete, true);
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
});
