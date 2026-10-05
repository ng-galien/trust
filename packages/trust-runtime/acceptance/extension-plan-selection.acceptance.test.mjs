import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAccessTestProvider, DEVELOPMENT_SCOPES } from "../../../environments/trust-test/auth/provider.mjs";
import { startRuntime } from "../dist/src/server.js";
import { root, rpc, scopes } from "./access-ownership-support.mjs";

// The development identity provider issues use scopes for its disposable probe identities only.
const EXTENSION = "extension-a";

const SERVER = `
export const createExtension = ({ trust }) => ({
  async prepare() {},
  async start() {},
  async stop() {},
  async read() { return { status: 200, body: {} }; },
  async command(input, context) {
    const { selection } = input.arguments;
    try {
      const result = await (selection === undefined ? trust.listPlans(context) : trust.listPlans(context, selection));
      return { status: 200, body: { result }, text: "listed" };
    } catch (error) {
      return { status: 200, body: { failure: error.failure }, text: "refused" };
    }
  },
});
`;

// Engagement order; the foreign Plans share the procedures but belong to another environment.
const PLANS = [
  { plan: "status-local-1", procedure: "git-status", environment: "local" },
  { plan: "input-local-1", procedure: "optional-agent-declarations", environment: "local" },
  { plan: "status-foreign", procedure: "git-status", environment: "foreign" },
  { plan: "input-local-2", procedure: "optional-agent-declarations", environment: "local" },
  { plan: "status-local-2", procedure: "git-status", environment: "local" },
  { plan: "input-foreign", procedure: "optional-agent-declarations", environment: "foreign" },
];
const CANCELLED = "status-local-2";
const NEWEST_LOCAL = ["status-local-2", "input-local-2", "input-local-1", "status-local-1"];

const SELECTIONS = [
  [{}, NEWEST_LOCAL],
  [{ procedure: "optional-agent-declarations" }, ["input-local-2", "input-local-1"]],
  [{ mode: "dry-run" }, ["status-local-2", "status-local-1"]],
  [{ mode: "live" }, ["input-local-2", "input-local-1"]],
  [{ workState: "CANCELLED" }, ["status-local-2"]],
  [{ procedure: "git-status", mode: "dry-run", workState: "IN_PROGRESS" }, ["status-local-1"]],
  [{ procedure: "git-status", mode: "live" }, []],
  [{ workState: "COMPLETE" }, []],
];
const LIMITS = [
  [{ limit: 1 }, NEWEST_LOCAL.slice(0, 1)],
  [{ limit: 2 }, NEWEST_LOCAL.slice(0, 2)],
  [{ limit: 3 }, NEWEST_LOCAL.slice(0, 3)],
  [{ limit: 10 }, NEWEST_LOCAL],
  [{ procedure: "git-status", limit: 1 }, ["status-local-2"]],
  [{ mode: "live", workState: "IN_PROGRESS", limit: 1 }, ["input-local-2"]],
];

let directory;
let provider;
let runtime;
let endpoint;
let alice;

const query = (selection) => new URLSearchParams(Object.entries(selection).map(([key, value]) => [key, String(value)]));
const listOverHttp = async (search) => {
  const response = await fetch(`${endpoint}/extensions/${EXTENSION}/trust/plans?${search}`, {
    headers: { authorization: `Bearer ${alice.token}` },
  });
  return { status: response.status, body: await response.json() };
};
const httpPlans = async (selection) => {
  const { status, body } = await listOverHttp(query(selection));
  assert.equal(status, 200, JSON.stringify({ selection, body }));
  return body.plans;
};
const gateway = async (selection) => {
  const response = await fetch(`${endpoint}/extensions/${EXTENSION}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ command: "plans.list", arguments: selection === undefined ? {} : { selection } }),
  });
  assert.equal(response.status, 200);
  return response.json();
};
const names = (plans) => plans.map((plan) => plan.plan);

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "trust-extension-plan-selection-"));
  provider = await createAccessTestProvider();
  await writeFile(path.join(directory, "server.mjs"), SERVER);
  const manifest = path.join(directory, `${EXTENSION}.json`);
  await writeFile(
    manifest,
    JSON.stringify({
      contract: "trust.extension@1",
      id: EXTENSION,
      title: "Plan selection probe",
      version: "1.0.0",
      server: "./server.mjs",
      configuration: {},
      requestedCapabilities: ["plans.read"],
      mcp: {
        description: "Lists Plans through the server gateway.",
        commands: [
          {
            name: "plans.list",
            readOnly: true,
            description: "List the Plans of the environment.",
            inputSchema: { type: "object" },
          },
        ],
      },
    }),
  );
  const registry = path.join(directory, "extensions.json");
  await writeFile(
    registry,
    JSON.stringify({
      extensions: [{ manifest, configuration: {}, environment: "local", grants: ["plans.read"], autoStart: true }],
    }),
  );
  runtime = await startRuntime({
    host: "127.0.0.1",
    port: 0,
    storage: { kind: "pglite", directory: path.join(directory, "data") },
    extensionsFile: registry,
    operationsDirectory: path.join(root, "assets/operations"),
    accessConfiguration: provider.configuration,
  });
  endpoint = `http://127.0.0.1:${runtime.port}`;
  const admin = await provider.issue({ subject: "admin", scope: DEVELOPMENT_SCOPES.join(" ") });
  alice = await provider.issue({
    subject: "alice",
    scope: [...scopes(), `trust.extension.${EXTENSION}.use`].join(" "),
  });
  for (const environment of ["local", "foreign"])
    await rpc(endpoint, admin.token, "environment.save", { environment, values: { workspaceRoot: root } });
  for (const [file, sourceName] of [
    ["assets/procedures/00-git-status.feature", "git-status.feature"],
    ["packages/trust-runtime/acceptance/fixtures/optional-agent-declarations.feature", "optional.feature"],
  ])
    await rpc(endpoint, admin.token, "procedure.publish", {
      source: await readFile(path.join(root, file), "utf8"),
      sourceName,
    });
  for (const { plan, procedure, environment } of PLANS) {
    const status = procedure === "git-status";
    await rpc(endpoint, alice.token, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure,
      procedureVersion: status ? "2.0.0" : "1.0.0",
      plan,
      environment,
      ...(status ? { mode: "dry-run", rootInputs: { repository: "repository" } } : { rootInputs: { workspace: "." } }),
    });
    // Distinct creation instants make the newest-first order observable.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await rpc(endpoint, admin.token, "plan.cancel", { plan: CANCELLED, reason: "Selection fixture" });
});

after(async () => {
  await runtime?.close();
  await provider?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("EXT-010 AC1 the HTTP Plan list of an extension takes a procedure, a mode and a work state and gives the matching Plans of its environment", {
  timeout: 60000,
}, async () => {
  for (const [selection, expected] of SELECTIONS) {
    const plans = await httpPlans(selection);
    assert.deepEqual(names(plans), expected, JSON.stringify(selection));
    for (const plan of plans) {
      assert.equal(plan.environment, "local");
      if (selection.procedure) assert.equal(plan.procedure, selection.procedure);
      if (selection.mode) assert.equal(plan.mode, selection.mode);
      if (selection.workState) assert.equal(plan.workState, selection.workState);
    }
  }
});

test("EXT-010 AC2 with a limit the Plan list gives at most that many Plans, newest first", {
  timeout: 60000,
}, async () => {
  for (const [selection, expected] of LIMITS) {
    const plans = await httpPlans(selection);
    assert.ok(plans.length <= selection.limit, JSON.stringify(selection));
    assert.deepEqual(names(plans), expected, JSON.stringify(selection));
  }
});

test("EXT-010 AC3 a malformed selection is refused with status 400", { timeout: 60000 }, async () => {
  for (const search of [
    "plan=status-local-1",
    "cursor=abc",
    "mode=other",
    "mode=LIVE",
    "workState=unknown",
    "workState=in_progress",
    "limit=0",
    "limit=-1",
    "limit=1.5",
    "limit=two",
    "limit=",
    "limit=1&limit=2",
    "procedure=",
  ]) {
    const { status, body } = await listOverHttp(search);
    assert.equal(status, 400, search);
    assert.equal(body.error?.code, "invalid-extension-query", search);
  }
});

test("EXT-010 AC4 the gateway of an extension server takes the same selection and limit and gives the same result as the HTTP list", {
  timeout: 60000,
}, async () => {
  // An extension that calls the gateway without a selection keeps the whole list of its environment.
  const unselected = await gateway(undefined);
  assert.deepEqual(unselected.result, await httpPlans({}), JSON.stringify(unselected));
  for (const [selection, expected] of [...SELECTIONS, ...LIMITS]) {
    const listed = await gateway(selection);
    assert.ok(listed.result, JSON.stringify({ selection, listed }));
    assert.deepEqual(listed.result, await httpPlans(selection), JSON.stringify(selection));
    assert.deepEqual(names(listed.result), expected, JSON.stringify(selection));
  }
  for (const selection of [
    { plan: "status-local-1" },
    { mode: "other" },
    { workState: "unknown" },
    { limit: 0 },
    { limit: 1.5 },
    { limit: "2" },
    { procedure: "" },
  ])
    assert.equal((await gateway(selection)).failure, "invalid-request", JSON.stringify(selection));
});
