import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "./support/fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const operationsDirectory = path.join(repositoryRoot, "assets/operations");

test("the public runtime exposes the resources required by the TRUST interface", async ({ runtime }) => {
  const operations = (await rpc(runtime.endpoint, "operation.list", {})) as {
    contract: string;
    operations: Array<{ operation: string; source: string }>;
  };
  assert.equal(operations.contract, "trust.operation-catalog@1");
  const gitHead = operations.operations.find(({ operation }) => operation === "git.head-read");
  assert.ok(gitHead);

  const compiledOperation = (await rpc(runtime.endpoint, "operation.compile", {
    source: gitHead.source,
    sourceName: "git.head-read.feature",
  })) as { operation: string };
  assert.equal(compiledOperation.operation, "git.head-read");
  assert.deepEqual(compiledOperation, gitHead);

  const simulation = (await rpc(runtime.endpoint, "operation.simulate", {
    source: gitHead.source,
    sourceName: "git.head-read.feature",
    input: { project: "trust" },
    environment: { workspaceRoot: repositoryRoot },
    steps: {
      head: { stdout: "revision-1\n" },
      status: { stdout: " M package.json\n" },
    },
  })) as { contract: string; produced: Record<string, unknown> };
  assert.equal(simulation.contract, "trust.operation-simulation@1");
  assert.deepEqual(simulation.produced, {
    headRevision: "revision-1",
    workingTree: "dirty",
  });

  const procedureFile = path.join(repositoryRoot, "assets/procedures/00-git-status.feature");
  const source = await readFile(procedureFile, "utf8");
  await rpc(runtime.endpoint, "procedure.publish", { source, sourceName: procedureFile });
  const procedures = (await rpc(runtime.endpoint, "procedure.list", {})) as {
    contract: string;
    procedures: Array<{ procedure: { procedure: string; version: string } }>;
  };
  assert.equal(procedures.contract, "trust.procedure-catalog@1");
  assert.equal(procedures.procedures[0]?.procedure.procedure, "git-status");

  const engagement = (await rpc(runtime.endpoint, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan: "ui-resource-plan",
    environment: "local",
    metadata: {
      title: "Inspect TRUST before release",
      labels: ["release", "trust"],
      annotations: { "coordination.origin": "runtime-acceptance" },
    },
    rootInputs: { repository: "trust" },
  })) as { checkUris: string[]; metadata: { title: string; labels: string[]; annotations: Record<string, string> } };
  assert.equal(engagement.checkUris.length, 1);
  assert.deepEqual(engagement.metadata, {
    title: "Inspect TRUST before release",
    labels: ["release", "trust"],
    annotations: { "coordination.origin": "runtime-acceptance" },
  });

  const plans = (await rpc(runtime.endpoint, "plan.list", {})) as {
    contract: string;
    plans: Array<{
      plan: string;
      checkCount: number;
      metadata: unknown;
      intentChaining: boolean;
      intentChainState: string;
      currentIntent: string | null;
    }>;
  };
  assert.equal(plans.contract, "trust.plan-catalog@1");
  assert.deepEqual(
    plans.plans.map(({ plan }) => plan),
    ["ui-resource-plan"],
  );
  assert.equal(plans.plans[0]?.checkCount, 1);
  assert.deepEqual(plans.plans[0]?.metadata, engagement.metadata);
  assert.deepEqual(
    {
      intentChaining: plans.plans[0]?.intentChaining,
      intentChainState: plans.plans[0]?.intentChainState,
      currentIntent: plans.plans[0]?.currentIntent,
    },
    { intentChaining: false, intentChainState: "DISABLED", currentIntent: null },
  );

  const plan = (await rpc(runtime.endpoint, "plan.read", { plan: "ui-resource-plan" })) as {
    contract: string;
    revisions: unknown[];
    sessions: unknown[];
    checks: Array<{ checkUri: string }>;
    metadata: unknown;
  };
  assert.equal(plan.contract, "trust.plan-view@1");
  assert.equal(plan.revisions.length, 1);
  assert.equal(plan.sessions.length, 1);
  assert.equal(plan.checks[0]?.checkUri, engagement.checkUris[0]);
  assert.deepEqual(plan.metadata, engagement.metadata);

  const session = (await rpc(runtime.endpoint, "session.read", { plan: "ui-resource-plan" })) as {
    contract: string;
    sessions: unknown[];
  };
  assert.equal(session.contract, "trust.session-view@1");
  assert.equal(session.sessions.length, 1);

  const check = (await rpc(runtime.endpoint, "check.read", {
    contract: "trust.check-read-request@1",
    checkUri: engagement.checkUris[0],
  })) as { contract: string; attempts: unknown[]; history: unknown[]; context: Record<string, unknown> };
  assert.equal(check.contract, "trust.check-view@1");
  assert.deepEqual(check.attempts, []);
  assert.deepEqual(check.history, []);
  assert.equal(check.context.repository, "trust");
});

test("Plan metadata is validated, immutable and preserved by re-engagement and reset", async ({ runtime }) => {
  const procedureFile = path.join(repositoryRoot, "assets/procedures/00-git-status.feature");
  await rpc(runtime.endpoint, "procedure.publish", {
    source: await readFile(procedureFile, "utf8"),
    sourceName: procedureFile,
  });
  const input = {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan: "metadata-lifecycle",
    environment: "local",
    metadata: {
      title: "Inspect metadata lifecycle",
      labels: ["acceptance", "metadata"],
      annotations: { "coordination.origin": "runtime-acceptance" },
    },
    rootInputs: { repository: "trust" },
    mode: "dry-run",
  };
  const engaged = (await rpc(runtime.endpoint, "plan.engage", input)) as { metadata: unknown };

  const repeated = (await rpc(
    runtime.endpoint,
    "plan.engage",
    (({ metadata: _metadata, ...rest }) => rest)(input),
  )) as { metadata: unknown };
  assert.deepEqual(repeated.metadata, engaged.metadata);

  const changed = await rpcEnvelope(runtime.endpoint, "plan.engage", {
    ...input,
    metadata: { ...input.metadata, title: "Another title" },
  });
  assert.equal(changed.error?.data?.reason, "plan-conflict");

  const invalid = await rpcEnvelope(runtime.endpoint, "plan.engage", {
    ...input,
    plan: "invalid-metadata",
    metadata: { labels: ["Not-Lowercase"] },
  });
  assert.equal(invalid.error?.data?.reason, "invalid-plan-engagement");

  const reset = (await rpc(runtime.endpoint, "plan.reset", { plan: input.plan })) as { metadata: unknown };
  assert.deepEqual(reset.metadata, engaged.metadata);
  const view = (await rpc(runtime.endpoint, "plan.read", { plan: input.plan })) as { metadata: unknown };
  assert.deepEqual(view.metadata, engaged.metadata);
});

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}

async function rpcEnvelope(
  endpoint: string,
  method: string,
  params: unknown,
): Promise<{
  result?: unknown;
  error?: { code: number; message: string; data?: { reason?: string } };
}> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    result?: unknown;
    error?: { code: number; message: string; data?: { reason?: string } };
  }>;
}
