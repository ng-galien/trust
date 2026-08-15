import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startPublicRuntime } from "./support/runtime-process.js";
import { otlpFactAttributes } from "./support/otlp-fact.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const operationsDirectory = path.join(repositoryRoot, "assets/operations");

test("a Plan engages before future agent declarations exist", async () => {
  const runtime = await startRuntime("trust-future-declarations-");
  try {
    await publish(runtime.endpoint, path.join(
      repositoryRoot,
      "assets/procedures/04-end-to-end-red-green.feature",
    ));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "end-to-end-red-green",
      procedureVersion: "2.0.0",
      plan: "future-declarations",
      environment: "local",
      rootInputs: { "jira issue": "TK-100", trace: "trace-100" },
    }) as { revision: number; checkUris: readonly string[] };

    assert.equal(engagement.revision, 1);
    assert.equal(engagement.checkUris.length, 3);
    assert.ok(engagement.checkUris.some((uri) => uri.includes("git-head-read")));
    assert.ok(engagement.checkUris.some((uri) => uri.includes("jira-issue-read")));
    assert.ok(engagement.checkUris.some((uri) => uri.includes("telemetry-trace-read")));
  } finally {
    await runtime.close();
  }
});

test("correlated Operation values produce the right Check Input for each declared project", async () => {
  const runtime = await startRuntime("trust-correlated-plan-");
  try {
    await publish(runtime.endpoint, fixture("correlated-plan.feature"));
    const engagementInput = {
      contract: "trust.plan-engagement-request@1",
      procedure: "correlated-plan",
      procedureVersion: "1.0.0",
      plan: "correlated-plan",
      environment: "local",
      rootInputs: {},
    } as const;
    const engaged = await rpc(runtime.endpoint, "plan.engage", engagementInput) as {
      revision: number;
      checkUris: readonly string[];
    };
    assert.equal(engaged.revision, 1);
    assert.deepEqual(engaged.checkUris, []);

    const replacement = await mcpTool(runtime.endpoint, "trust_plan_declarations_replace", {
      plan: "correlated-plan",
      expectedRevision: 1,
      declarations: { project: ["project-a", "project-b"] },
    });
    assert.match(replacement, /Revision: 2/);
    const baselineUris = uniqueUris(replacement).filter((uri) => uri.includes("git-head-read"));
    assert.equal(baselineUris.length, 2);
    assert.notEqual(baselineUris[0], baselineUris[1]);

    const revisions = new Map([
      ["project-a", "revision-a"],
      ["project-b", "revision-b"],
    ]);
    for (const checkUri of baselineUris) {
      const admission = await admit(runtime.endpoint, checkUri, `baseline-${checkUri.slice(-8)}`);
      const project = String(admission.actionInput.project);
      const revision = revisions.get(project);
      assert.ok(revision, `unexpected project ${project}`);
      await sendRunnerFacts(runtime.endpoint, admission, {
        kind: admission.operation.operation,
        observedAt: "2026-08-15T12:00:00.000Z",
        values: { headRevision: revision, workingTree: "clean" },
      });
      await rpc(runtime.endpoint, "check.attempt.finalize", {
        contract: "trust.attempt-finalization-request@1",
        attemptHandle: admission.attemptHandle,
      });
    }

    const current = await rpc(runtime.endpoint, "plan.engage", engagementInput) as {
      revision: number;
      checkUris: readonly string[];
    };
    assert.equal(current.revision, 4);
    const comparisonUris = current.checkUris.filter((uri) => uri.includes("git-head-compare"));
    assert.equal(comparisonUris.length, 2);

    const compared = new Map<string, string>();
    for (const checkUri of comparisonUris) {
      const admission = await admit(runtime.endpoint, checkUri, `compare-${checkUri.slice(-8)}`);
      compared.set(
        String(admission.actionInput.project),
        String(admission.actionInput.baseRevision),
      );
    }
    assert.deepEqual(compared, revisions);
  } finally {
    await runtime.close();
  }
});

test("two Check names keep distinct URIs with the same Operation and target", async () => {
  const runtime = await startRuntime("trust-distinct-checks-");
  try {
    await publish(runtime.endpoint, fixture("distinct-checks.feature"));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "distinct-checks",
      procedureVersion: "1.0.0",
      plan: "distinct-checks",
      environment: "local",
      rootInputs: { repository: "repository" },
    }) as { checkUris: readonly string[] };
    assert.equal(engagement.checkUris.length, 2);
    assert.equal(new Set(engagement.checkUris).size, 2);
  } finally {
    await runtime.close();
  }
});

test("Fact rejection is atomic and Attempt finalization is idempotent", async () => {
  const runtime = await startRuntime("trust-attempt-replay-");
  try {
    const source = path.join(repositoryRoot, "assets/procedures/00-git-status.feature");
    await publish(runtime.endpoint, source);
    const engagementInput = {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "attempt-replay",
      environment: "local",
      rootInputs: { repository: "repository" },
    } as const;
    const engagement = await rpc(runtime.endpoint, "plan.engage", engagementInput) as {
      checkUris: readonly string[];
    };
    const admission = await admit(runtime.endpoint, engagement.checkUris[0]!, "attempt-replay-1");

    const rejected = await sendRunnerFacts(runtime.endpoint, admission, {
      kind: admission.operation.operation,
      observedAt: "2026-08-15T12:00:00.000Z",
      values: { headRevision: "revision-a" },
    });
    assert.equal(rejected.partialSuccess?.rejectedSpans, 1);
    const beforeFacts = await rpcFailure(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: admission.attemptHandle,
    });
    assert.equal(beforeFacts.data?.reason, "facts-missing");

    const accepted = await sendRunnerFacts(runtime.endpoint, admission, {
      kind: admission.operation.operation,
      observedAt: "2026-08-15T12:00:00.000Z",
      values: { headRevision: "revision-a", workingTree: "clean" },
    });
    assert.equal(accepted.partialSuccess, undefined);
    const first = await rpc(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: admission.attemptHandle,
    });
    const replay = await rpc(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: admission.attemptHandle,
    });
    assert.deepEqual(replay, first);
    const current = await rpc(runtime.endpoint, "plan.engage", engagementInput) as { revision: number };
    assert.equal(current.revision, 2);

    const afterFinalization = await sendRunnerFacts(runtime.endpoint, admission, {
      kind: admission.operation.operation,
      observedAt: "2026-08-15T12:00:01.000Z",
      values: { headRevision: "revision-b", workingTree: "clean" },
    });
    assert.equal(afterFinalization.partialSuccess?.rejectedSpans, 1);
  } finally {
    await runtime.close();
  }
});

test("a runner trace cannot write Facts for a Skill Attempt", async () => {
  const runtime = await startRuntime("trust-attempt-owner-");
  try {
    await publish(runtime.endpoint, path.join(repositoryRoot, "assets/procedures/00-git-status.feature"));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "attempt-owner",
      environment: "local",
      rootInputs: { repository: "repository" },
    }) as { checkUris: readonly string[] };
    const admission = await rpc(runtime.endpoint, "skill.attempt.admit", {
      contract: "trust.skill-admission-request@1",
      attemptKey: "skill-attempt-1",
      checkUri: engagement.checkUris[0],
      releaseDigest: `sha256:${"a".repeat(64)}`,
      environment: "local",
      deploymentKey: "deployment-1",
      envelope: "cli",
      runtimeIdentity: "spiffe://trust-test/runtime",
      processIdentity: "urn:uuid:00000000-0000-4000-8000-000000000001",
    }) as {
      attemptKey: string;
      attemptHandle: string;
      checkUri: string;
      operation: string;
    };

    const rejected = await postFacts(runtime.endpoint, {
      attemptKey: admission.attemptKey,
      attemptHandle: admission.attemptHandle,
      checkUri: admission.checkUri,
    }, {
      kind: admission.operation,
      observedAt: "2026-08-15T12:00:00.000Z",
      values: { headRevision: "revision-a", workingTree: "clean" },
    });
    assert.equal(rejected.partialSuccess?.rejectedSpans, 1);
  } finally {
    await runtime.close();
  }
});

interface RunnerAdmission {
  readonly attemptKey: string;
  readonly attemptHandle: string;
  readonly checkUri: string;
  readonly actionInput: Readonly<Record<string, unknown>>;
  readonly operation: { readonly operation: string };
}

async function startRuntime(prefix: string) {
  return startPublicRuntime(prefix, {
    skillPolicy: "local",
    operationsDirectory,
    environments: { local: { projectRoot: repositoryRoot } },
  });
}

function fixture(name: string): string {
  return path.join(repositoryRoot, "packages/trust-runtime/acceptance/fixtures", name);
}

async function publish(endpoint: string, file: string): Promise<void> {
  await rpc(endpoint, "procedure.publish", {
    source: await readFile(file, "utf8"),
    sourceName: path.basename(file),
  });
}

async function admit(endpoint: string, checkUri: string, attemptKey: string): Promise<RunnerAdmission> {
  return rpc(endpoint, "check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey,
    checkUri,
  }) as Promise<RunnerAdmission>;
}

async function sendRunnerFacts(
  endpoint: string,
  admission: RunnerAdmission,
  fact: Readonly<Record<string, unknown>>,
) {
  return postFacts(endpoint, admission, fact);
}

async function postFacts(
  endpoint: string,
  attempt: { readonly attemptKey: string; readonly attemptHandle: string; readonly checkUri: string },
  fact: Readonly<Record<string, unknown>>,
): Promise<{ partialSuccess?: { rejectedSpans?: number; errorMessage?: string } }> {
  const response = await fetch(`${endpoint}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "trust.runner.facts",
            startTimeUnixNano: "1786795200000000000",
            attributes: [
              { key: "trust.attempt_key", value: { stringValue: attempt.attemptKey } },
              { key: "trust.attempt_handle", value: { stringValue: attempt.attemptHandle } },
              { key: "trust.check_uri", value: { stringValue: attempt.checkUri } },
            ],
            events: [{ name: "trust.runner.fact", attributes: otlpFactAttributes(fact, 0) }],
          }],
        }],
      }],
    }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ partialSuccess?: { rejectedSpans?: number; errorMessage?: string } }>;
}

async function mcpTool(
  endpoint: string,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string> {
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json() as {
    result?: { content?: readonly { type?: string; text?: string }[]; isError?: boolean };
    error?: unknown;
  };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  assert.notEqual(envelope.result?.isError, true, envelope.result?.content?.[0]?.text);
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return text!;
}

function uniqueUris(text: string): string[] {
  return [...new Set([...text.matchAll(/trust:\/\/[^\s]+/g)].map(([uri]) => uri))];
}

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}

async function rpcFailure(endpoint: string, method: string, params: unknown) {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.notEqual(envelope.error, undefined);
  return envelope.error!;
}

async function rpcEnvelope(endpoint: string, method: string, params: unknown): Promise<{
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
