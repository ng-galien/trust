import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startPublicRuntime } from "./support/runtime-process.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const operationsDirectory = path.join(repositoryRoot, "assets/operations");

test("the public runtime exposes the resources required by the TRUST interface", async () => {
  const runtime = await startPublicRuntime("trust-ui-resources-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  try {
    const operations = await rpc(runtime.endpoint, "operation.list", {}) as {
      contract: string;
      operations: Array<{ operation: string; source: string }>;
    };
    assert.equal(operations.contract, "trust.operation-catalog@1");
    const gitHead = operations.operations.find(({ operation }) => operation === "git.head-read");
    assert.ok(gitHead);

    const compiledOperation = await rpc(runtime.endpoint, "operation.compile", {
      source: gitHead.source,
      sourceName: "git.head-read.feature",
    }) as { operation: string };
    assert.equal(compiledOperation.operation, "git.head-read");
    assert.deepEqual(compiledOperation, gitHead);

    const simulation = await rpc(runtime.endpoint, "operation.simulate", {
      source: gitHead.source,
      sourceName: "git.head-read.feature",
      input: { project: "trust" },
      environment: { workspaceRoot: repositoryRoot },
      steps: {
        head: { stdout: "revision-1\n" },
        status: { stdout: " M package.json\n" },
      },
    }) as { contract: string; produced: Record<string, unknown> };
    assert.equal(simulation.contract, "trust.operation-simulation@1");
    assert.deepEqual(simulation.produced, {
      headRevision: "revision-1",
      workingTree: "dirty",
    });

    const procedureFile = path.join(repositoryRoot, "assets/procedures/00-git-status.feature");
    const source = await readFile(procedureFile, "utf8");
    await rpc(runtime.endpoint, "procedure.publish", { source, sourceName: procedureFile });
    const procedures = await rpc(runtime.endpoint, "procedure.list", {}) as {
      contract: string;
      procedures: Array<{ procedure: { procedure: string; version: string } }>;
    };
    assert.equal(procedures.contract, "trust.procedure-catalog@1");
    assert.equal(procedures.procedures[0]?.procedure.procedure, "git-status");

    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "ui-resource-plan",
      environment: "local",
      rootInputs: { repository: "trust" },
    }) as { checkUris: string[] };
    assert.equal(engagement.checkUris.length, 1);

    const plans = await rpc(runtime.endpoint, "plan.list", {}) as {
      contract: string;
      plans: Array<{ plan: string; checkCount: number }>;
    };
    assert.equal(plans.contract, "trust.plan-catalog@1");
    assert.deepEqual(plans.plans.map(({ plan }) => plan), ["ui-resource-plan"]);
    assert.equal(plans.plans[0]?.checkCount, 1);

    const plan = await rpc(runtime.endpoint, "plan.read", { plan: "ui-resource-plan" }) as {
      contract: string;
      revisions: unknown[];
      sessions: unknown[];
      checks: Array<{ checkUri: string }>;
    };
    assert.equal(plan.contract, "trust.plan-view@1");
    assert.equal(plan.revisions.length, 1);
    assert.equal(plan.sessions.length, 1);
    assert.equal(plan.checks[0]?.checkUri, engagement.checkUris[0]);

    const session = await rpc(runtime.endpoint, "session.read", { plan: "ui-resource-plan" }) as {
      contract: string;
      sessions: unknown[];
    };
    assert.equal(session.contract, "trust.session-view@1");
    assert.equal(session.sessions.length, 1);

    const check = await rpc(runtime.endpoint, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri: engagement.checkUris[0],
    }) as { contract: string; attempts: unknown[]; history: unknown[]; context: Record<string, unknown> };
    assert.equal(check.contract, "trust.check-view@1");
    assert.deepEqual(check.attempts, []);
    assert.deepEqual(check.history, []);
    assert.equal(check.context.repository, "trust");
  } finally {
    await runtime.close();
  }
});

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json() as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}
