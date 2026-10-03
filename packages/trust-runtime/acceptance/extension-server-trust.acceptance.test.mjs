import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccessTestProvider, DEVELOPMENT_SCOPES } from "../../../environments/trust-test/auth/provider.mjs";
import { startRuntime } from "../dist/src/server.js";
import { root, rpc, scopes } from "./access-ownership-support.mjs";

const SERVER = `
let kept;
const call = (trust, request, context) => {
  switch (request.call) {
    case "listPlans": return trust.listPlans(context);
    case "readPlan": return trust.readPlan(request.plan, context);
    case "readEpisode": return trust.readEpisode(request.plan, context);
    case "replaceDeclarations": return trust.replaceDeclarations(request.input, context);
    case "readProcedure": return trust.readProcedure(request.procedure, request.version, context);
    case "readOperation": return trust.readOperation(request.operation, request.version, context);
    case "keep": kept = context; return "kept";
    case "reuse": return trust.readPlan(request.plan, kept);
    case "slow": return new Promise((resolve) => setTimeout(() => resolve("late"), 3000));
  }
};
export const createExtension = ({ trust }) => ({
  async prepare() {},
  async start() {},
  async stop() {},
  async read() { return { status: 200, body: {} }; },
  async command(input, context) {
    try {
      const result = await call(trust, input.arguments, context);
      return { status: 200, body: { result }, text: "done" };
    } catch (error) {
      return { status: 200, body: { failure: error.failure, message: error.message }, text: "refused" };
    }
  },
});
`;

const COMMAND = {
  name: "trust.probe",
  readOnly: false,
  description: "Call one server-side TRUST surface.",
  inputSchema: { type: "object" },
};

test("an extension server reads and declares through TRUST with its caller's access, its grants and its environment", {
  timeout: 90000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-server-trust-"));
  const provider = await createAccessTestProvider();
  let runtime;
  try {
    await writeFile(path.join(directory, "server.mjs"), SERVER);
    const installations = [];
    for (const [id, grants] of [
      ["dragon-heist", ["plans.read", "plans.declare", "catalog.read"]],
      ["extension-b", []],
    ]) {
      const manifest = path.join(directory, `${id}.json`);
      await writeFile(
        manifest,
        JSON.stringify({
          contract: "trust.extension@1",
          id,
          title: "Server-side TRUST access",
          version: "1.0.0",
          server: "./server.mjs",
          configuration: {},
          requestedCapabilities: ["plans.read", "plans.declare", "catalog.read"],
          mcp: { description: "Server-side TRUST probe.", commands: [COMMAND] },
        }),
      );
      installations.push({ manifest, configuration: {}, environment: "local", grants, autoStart: true });
    }
    const registry = path.join(directory, "extensions.json");
    await writeFile(registry, JSON.stringify({ extensions: installations }));
    runtime = await startRuntime({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "data") },
      extensionsFile: registry,
      extensionTimeoutMs: 1500,
      operationsDirectory: path.join(root, "assets/operations"),
      accessConfiguration: provider.configuration,
    });
    const endpoint = `http://127.0.0.1:${runtime.port}`;
    const admin = await provider.issue({ subject: "admin", scope: DEVELOPMENT_SCOPES.join(" ") });
    const use = ["trust.extension.dragon-heist.use", "trust.extension.extension-b.use"];
    const alice = await provider.issue({
      subject: "alice",
      scope: [...scopes(), "trust.procedure.read", "trust.operation.read", ...use].join(" "),
    });
    const bob = await provider.issue({ subject: "bob", scope: [...scopes(), ...use].join(" ") });
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
    const probe = async (token, request, extension = "dragon-heist") => {
      const response = await fetch(`${endpoint}/extensions/${extension}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ command: "trust.probe", arguments: request }),
      });
      return { status: response.status, ...(await response.json()) };
    };

    // Plans: the caller's rights, confined to the installation environment.
    const listed = await probe(alice.token, { call: "listPlans" });
    assert.ok(listed.result, JSON.stringify(listed));
    assert.deepEqual(
      listed.result.map((plan) => plan.plan),
      ["input-local"],
      JSON.stringify(listed),
    );
    const read = await probe(alice.token, { call: "readPlan", plan: "input-local" });
    assert.equal(read.result.plan, "input-local", JSON.stringify(read));
    assert.equal(read.result.environment, "local");
    assert.equal((await probe(alice.token, { call: "readPlan", plan: "input-foreign" })).failure, "not-found");
    assert.equal((await probe(alice.token, { call: "readPlan", plan: "missing" })).failure, "not-found");
    assert.deepEqual((await probe(bob.token, { call: "listPlans" })).result, []);
    assert.equal((await probe(bob.token, { call: "readPlan", plan: "input-local" })).failure, "not-found");
    const episode = await probe(alice.token, { call: "readEpisode", plan: "input-local" });
    assert.equal(episode.result.root.plan.plan, "input-local", JSON.stringify(episode));

    // Declarations: the same revision-checked replacement as the extension page.
    const declare = (expectedRevision) => ({
      call: "replaceDeclarations",
      input: {
        contract: "trust.plan-declaration-replacement-request@1",
        plan: "input-local",
        expectedRevision,
        declarations: { "required note": "From the extension server" },
      },
    });
    const declared = await probe(alice.token, declare(1));
    assert.equal(declared.result.status, "REPLACED", JSON.stringify(declared));
    assert.equal((await probe(alice.token, declare(1))).failure, "refused");
    const plan = await rpc(endpoint, alice.token, "plan.read", { plan: "input-local" });
    assert.deepEqual(plan.declarations, { "required note": "From the extension server" });

    // Catalog: exact published versions, with the caller's catalog rights.
    const procedure = await probe(alice.token, {
      call: "readProcedure",
      procedure: "optional-agent-declarations",
      version: "1.0.0",
    });
    assert.equal(procedure.result.procedure, "optional-agent-declarations", JSON.stringify(procedure));
    const operation = await probe(alice.token, {
      call: "readOperation",
      operation: "workspace.gate-run",
      version: "1.0.0",
    });
    assert.equal(operation.result.operation, "workspace.gate-run", JSON.stringify(operation));
    assert.equal(
      (await probe(alice.token, { call: "readOperation", operation: "workspace.gate-run", version: "9.9.9" })).failure,
      "not-found",
    );
    assert.equal(
      (await probe(bob.token, { call: "readOperation", operation: "workspace.gate-run", version: "1.0.0" })).failure,
      "access-denied",
    );

    // Grants: an ungranted installation is refused every surface.
    for (const request of [
      { call: "listPlans" },
      { call: "readPlan", plan: "input-local" },
      declare(2),
      { call: "readProcedure", procedure: "optional-agent-declarations", version: "1.0.0" },
    ])
      assert.equal((await probe(alice.token, request, "extension-b")).failure, "capability-denied");

    // An invocation's access ends with it.
    assert.equal((await probe(alice.token, { call: "keep" })).result, "kept");
    assert.equal((await probe(alice.token, { call: "reuse", plan: "input-local" })).failure, "invocation-ended");

    // A slow invocation fails alone; the extension keeps running.
    assert.equal((await probe(alice.token, { call: "slow" })).status, 504);
    const extensions = await fetch(`${endpoint}/extensions`, {
      headers: { authorization: `Bearer ${admin.token}` },
    }).then((response) => response.json());
    assert.equal(
      extensions.extensions.find((extension) => extension.id === "dragon-heist").state,
      "RUNNING",
      JSON.stringify(extensions),
    );
    assert.equal((await probe(alice.token, { call: "readPlan", plan: "input-local" })).result.plan, "input-local");
  } finally {
    await runtime?.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
