import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "./support/fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const operationsDirectory = path.join(repositoryRoot, "assets/operations");

test("intent admission and interruption publish committed Plan state changes", { timeout: 15_000 }, async ({
  startRuntime,
}) => {
  const runtime = await startRuntime("trust-intent-events-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  const events = await openPlanEvents(runtime.endpoint);
  try {
    const source = await readFile(
      path.join(repositoryRoot, "packages/trust-runtime/acceptance/fixtures/intent-chaining.feature"),
      "utf8",
    );
    await rpc(runtime.endpoint, "procedure.publish", { source, sourceName: "intent-chaining.feature" });
    const engaged = (await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "intent-chaining",
      procedureVersion: "1.0.0",
      plan: "intent-events",
      environment: "local",
      rootInputs: { repository: "trust" },
      mode: "dry-run",
    })) as { checkUris: string[] };
    const checkUri = defined(engaged.checkUris[0], "engaged Check");
    await fetch(`${runtime.endpoint}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "trust_plan_read", arguments: { checkUri } },
      }),
    });
    const initial = (await rpc(runtime.endpoint, "plan.read", { plan: "intent-events" })) as { currentIntent: string };
    const admission = (await rpc(runtime.endpoint, "check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey: "intent-event-attempt",
      checkUri,
      intent: initial.currentIntent,
      nextIntent: "Observe the remaining Check",
    })) as { status: string; attemptHandle: string };
    assert.equal(admission.status, "ADMITTED");
    await events.takeUntil((event) => event.type === "plan.state" && event.plan === "intent-events");
    const pending = (await rpc(runtime.endpoint, "plan.read", { plan: "intent-events" })) as {
      currentIntent: string;
      nextIntent: string | null;
    };
    assert.deepEqual(
      { currentIntent: pending.currentIntent, nextIntent: pending.nextIntent },
      { currentIntent: initial.currentIntent, nextIntent: "Observe the remaining Check" },
    );
    await rpc(runtime.endpoint, "check.attempt.interrupt", {
      contract: "trust.attempt-interruption-request@1",
      attemptHandle: admission.attemptHandle,
    });
    await events.takeUntil((event) => event.type === "plan.state" && event.plan === "intent-events");
    const interrupted = (await rpc(runtime.endpoint, "plan.read", { plan: "intent-events" })) as {
      currentIntent: string;
      nextIntent: string | null;
    };
    assert.deepEqual(
      { currentIntent: interrupted.currentIntent, nextIntent: interrupted.nextIntent },
      { currentIntent: initial.currentIntent, nextIntent: null },
    );
  } finally {
    events.close();
    await runtime.close();
  }
});

test("the Operation catalog is writable and catalog summaries stay light", async ({ startRuntime }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-operations-"));
  await cp(operationsDirectory, directory, { recursive: true });
  const runtime = await startRuntime("trust-operation-catalog-", { operationsDirectory: directory });
  try {
    const original = await readFile(path.join(directory, "git.head-read.feature"), "utf8");
    const source = original.replace("@operation:git.head-read", "@operation:git.head-copy");
    const secondSource = original.replace("@operation:git.head-read", "@operation:git.head-copy-two");
    const [saved, secondSaved] = (await Promise.all([
      rpc(runtime.endpoint, "operation.save", {
        source,
        sourceName: "git.head-copy.feature",
      }),
      rpc(runtime.endpoint, "operation.save", {
        source: secondSource,
        sourceName: "git.head-copy-two.feature",
      }),
    ])) as [{ operation: { operation: string } }, { operation: { operation: string } }];
    assert.equal(saved.operation.operation, "git.head-copy");
    assert.equal(secondSaved.operation.operation, "git.head-copy-two");

    // Published identity and its source file are both protected from replacement.
    for (const candidate of [
      { source, sourceName: "git.head-copy.feature" },
      { source: `${source}\n# changed definition\n`, sourceName: "git.head-copy.feature" },
      { source, sourceName: "duplicate.feature" },
      { source: source.replace("@version:1.0.0", "@version:1.0.1"), sourceName: "git.head-copy.feature" },
    ]) {
      const refusal = await rpcFailure(runtime.endpoint, "operation.save", candidate);
      assert.equal(refusal.data?.reason, "operation-conflict");
      assert.equal(await readFile(path.join(directory, "git.head-copy.feature"), "utf8"), source);
    }
    const updatedSource = source.replace("@version:1.0.0", "@version:1.0.1");
    await rpc(runtime.endpoint, "operation.save", { source: updatedSource, sourceName: "git.head-copy-1.0.1.feature" });
    const retained = (await rpc(runtime.endpoint, "operation.read", {
      operation: "git.head-copy",
      version: "1.0.0",
    })) as { source: string };
    assert.equal(retained.source, source);

    const summaries = (await rpc(runtime.endpoint, "operation.list", { summary: true })) as {
      operations: Array<Record<string, unknown>>;
    };
    const summary = summaries.operations.find((operation) => operation.operation === "git.head-copy");
    assert.ok(summary);
    assert.equal(Object.hasOwn(summary, "source"), false);
    assert.equal(Object.hasOwn(summary, "steps"), false);
    assert.ok(summaries.operations.some((operation) => operation.operation === "git.head-copy-two"));

    const read = (await rpc(runtime.endpoint, "operation.read", { operation: "git.head-copy", version: "1.0.0" })) as {
      source: string;
    };
    assert.match(read.source, /@operation:git\.head-copy/);
    for (const [operation, version] of [
      ["git.head-copy", "1.0.0"],
      ["git.head-copy", "1.0.1"],
      ["git.head-copy-two", "1.0.0"],
    ]) {
      const refusal = await rpcFailure(runtime.endpoint, "operation.remove", { operation, version });
      assert.equal(refusal.data?.reason, "immutable-operation");
      await rpc(runtime.endpoint, "operation.read", { operation, version });
    }
    const unknownRemoval = await rpcFailure(runtime.endpoint, "operation.remove", {
      operation: "git.missing",
      version: "1.0.0",
    });
    assert.equal(unknownRemoval.data?.reason, "unknown-operation");

    const procedure = await readFile(path.join(repositoryRoot, "assets/procedures/00-git-status.feature"), "utf8");
    const emptyFailureReason = await rpcFailure(runtime.endpoint, "procedure.compile", {
      source: procedure.replace('"the repository has no local changes"', '""'),
      sourceName: "empty-failure-reason.feature",
    });
    assert.equal(emptyFailureReason.data?.reason, "invalid-procedure");
    assert.match(emptyFailureReason.data?.message ?? "", /Failure reason cannot be empty/);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two public runtimes cannot replace an Operation from a stale catalog", async ({ startRuntime }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-shared-catalog-"));
  const first = await startRuntime("trust-catalog-first-", { operationsDirectory: directory });
  const second = await startRuntime("trust-catalog-second-", { operationsDirectory: directory });
  try {
    const source = await readFile(path.join(operationsDirectory, "git.head-read.feature"), "utf8");
    await rpc(first.endpoint, "operation.save", { source, sourceName: "head.feature" });
    for (const candidate of [
      { source: `${source}\n# changed\n`, sourceName: "head.feature" },
      { source: `${source}\n# changed\n`, sourceName: "other.feature" },
      { source: source.replace("@version:1.0.0", "@version:1.0.1"), sourceName: "head.feature" },
    ]) {
      const refusal = await rpcFailure(second.endpoint, "operation.save", candidate);
      assert.equal(refusal.data?.reason, "operation-conflict");
      assert.equal(await readFile(path.join(directory, "head.feature"), "utf8"), source);
    }
    // Different identities competing for one new path must never replace the winner.
    const candidates = ["git.race-one", "git.race-two"].map((name) =>
      source.replace("@operation:git.head-read", `@operation:${name}`),
    );
    const results = await Promise.allSettled(
      [first, second].map((runtime, index) =>
        rpc(runtime.endpoint, "operation.save", { source: candidates[index], sourceName: "race.feature" }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    assert.equal(await readFile(path.join(directory, "race.feature"), "utf8"), candidates[winner]);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale event id from another runtime requires a full resync", async ({ startRuntime }) => {
  const firstRuntime = await startRuntime("trust-events-first-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  const firstStream = await openPlanEvents(firstRuntime.endpoint);
  let previousEventId: string | undefined;
  try {
    const procedureFile = path.join(repositoryRoot, "assets/procedures/00-git-status.feature");
    await rpc(firstRuntime.endpoint, "procedure.publish", {
      source: await readFile(procedureFile, "utf8"),
      sourceName: "00-git-status.feature",
    });
    await engage(firstRuntime.endpoint, "event-generation");
    const events = await firstStream.takeUntil((event) => event.type === "plan.engaged");
    previousEventId = events.at(-1)?.id;
    assert.ok(previousEventId);
  } finally {
    firstStream.close();
    await firstRuntime.close();
  }

  const secondRuntime = await startRuntime("trust-events-second-", { operationsDirectory });
  const secondStream = await openPlanEvents(secondRuntime.endpoint, previousEventId);
  try {
    const events = await secondStream.takeUntil((event) => event.type === "runtime.changed");
    assert.equal(events.at(-1)?.resync, true);
  } finally {
    secondStream.close();
    await secondRuntime.close();
  }
});

test("Plan pages, Check history and live events are served at public boundaries", async ({ startRuntime }) => {
  const runtime = await startRuntime("trust-backend-needs-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  const stream = await openPlanEvents(runtime.endpoint);
  try {
    const procedureFile = path.join(repositoryRoot, "assets/procedures/00-git-status.feature");
    await rpc(runtime.endpoint, "procedure.publish", {
      source: await readFile(procedureFile, "utf8"),
      sourceName: "00-git-status.feature",
    });
    const procedureSummaries = (await rpc(runtime.endpoint, "procedure.list", { summary: true })) as {
      procedures: Array<{ procedure: Record<string, unknown> }>;
    };
    const summary = defined(procedureSummaries.procedures[0], "Procedure summary");
    assert.equal(Object.hasOwn(summary.procedure, "source"), false);
    assert.equal(Object.hasOwn(summary.procedure, "checks"), false);

    for (const plan of ["rehearsal-a", "rehearsal-b", "rehearsal-c"]) {
      await engage(runtime.endpoint, plan);
    }
    const firstPage = (await rpc(runtime.endpoint, "plan.list", {
      filter: { mode: "dry-run", procedure: "git-status" },
      limit: 2,
    })) as { plans: Array<{ plan: string }>; nextCursor?: string };
    assert.equal(firstPage.plans.length, 2);
    assert.ok(firstPage.nextCursor);
    const secondPage = (await rpc(runtime.endpoint, "plan.list", {
      filter: { mode: "dry-run", procedure: "git-status" },
      limit: 2,
      cursor: firstPage.nextCursor,
    })) as { plans: Array<{ plan: string }>; nextCursor?: string };
    assert.equal(secondPage.plans.length, 1);
    assert.equal(secondPage.nextCursor, undefined);
    assert.equal(new Set([...firstPage.plans, ...secondPage.plans].map(({ plan }) => plan)).size, 3);
    await rpcFailure(runtime.endpoint, "plan.list", {
      filter: { mode: "live", procedure: "git-status" },
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    let view = await readPlan(runtime.endpoint, "rehearsal-a");
    const first = await admit(runtime.endpoint, defined(view.actionableChecks[0], "actionable Check"), "history-first");
    await facts(runtime.endpoint, first, { headRevision: "abc", workingTree: "dirty" });
    await finalize(runtime.endpoint, first.attemptHandle);
    view = await readPlan(runtime.endpoint, "rehearsal-a");
    const second = await admit(runtime.endpoint, defined(view.checks[0], "Check").checkUri, "history-second", true);
    await facts(runtime.endpoint, second, { headRevision: "def", workingTree: "clean" });
    await finalize(runtime.endpoint, second.attemptHandle);
    await rpc(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: second.checkUri,
      attemptHandle: second.attemptHandle,
      blockingReason: "The re-observation no longer satisfies the Check.",
      forbiddenFurtherAction: "Modify the repository to manufacture the expected status.",
    });
    view = await readPlan(runtime.endpoint, "rehearsal-a");
    await rpc(runtime.endpoint, "plan.resume", {
      plan: "rehearsal-a",
      escalationId: defined(view.activeEscalation, "active escalation").escalationId,
      resumeReason: "The operator reviewed the escalation and authorized a fresh observation.",
    });

    const historyOne = (await rpc(runtime.endpoint, "history.list", {
      filter: { plan: "rehearsal-a", mode: "dry-run", verdict: "NOT_VALIDATED" },
      limit: 1,
    })) as { snapshots: Array<{ plan: string; verdict: string; factCount: number }>; nextCursor?: string };
    assert.deepEqual(
      historyOne.snapshots.map(({ plan, verdict, factCount }) => [plan, verdict, factCount]),
      [["rehearsal-a", "NOT_VALIDATED", 1]],
    );
    assert.equal(historyOne.nextCursor, undefined);

    const historyPage = (await rpc(runtime.endpoint, "history.list", {
      filter: { plan: "rehearsal-a" },
      limit: 1,
    })) as {
      snapshots: Array<{ snapshotId: string }>;
      nextCursor?: string;
    };
    assert.ok(historyPage.nextCursor);
    await rpcFailure(runtime.endpoint, "history.list", {
      filter: { plan: "rehearsal-b" },
      limit: 1,
      cursor: historyPage.nextCursor,
    });
    const historyNext = (await rpc(runtime.endpoint, "history.list", {
      filter: { plan: "rehearsal-a" },
      limit: 1,
      cursor: historyPage.nextCursor,
    })) as { snapshots: Array<{ snapshotId: string }> };
    assert.notEqual(historyPage.snapshots[0]?.snapshotId, historyNext.snapshots[0]?.snapshotId);

    assert.deepEqual(await rpc(runtime.endpoint, "plan.close", { plan: "rehearsal-a" }), {
      plan: "rehearsal-a",
      closed: true,
    });
    const closed = await readPlan(runtime.endpoint, "rehearsal-a");
    assert.equal(closed.sessionState, "UNAVAILABLE");
    await rpc(runtime.endpoint, "plan.remove", { plan: "rehearsal-a" });

    // A removed Plan can no longer be access-filtered, so the stream announces it as a resync.
    const events = await stream.takeUntil((event) => event.type === "runtime.changed");
    assert.equal(events.at(-1)?.resync, true);
    assert.ok(events.some((event) => event.type === "plan.engaged" && event.plan === "rehearsal-a"));
    assert.ok(events.some((event) => event.type === "plan.revision" && event.cause === "verdict"));
    assert.ok(events.some((event) => event.type === "plan.state" && event.workState === "ESCALATED"));
    assert.ok(events.some((event) => event.type === "plan.state" && event.workState === "IN_PROGRESS"));
    assert.ok(events.some((event) => event.type === "session.changed" && event.session?.state === "closed"));
  } finally {
    stream.close();
    await runtime.close();
  }
});

interface Admission {
  attemptKey: string;
  attemptHandle: string;
  executionId: string;
  checkUri: string;
  operation: { operation: string };
}

interface PlanShape {
  sessionState: string;
  actionableChecks: readonly string[];
  checks: readonly { checkUri: string }[];
  activeEscalation: { escalationId: string } | null;
}

async function engage(endpoint: string, plan: string): Promise<void> {
  await rpc(endpoint, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan,
    environment: "local",
    rootInputs: { repository: "trust" },
    mode: "dry-run",
  });
}

async function readPlan(endpoint: string, plan: string): Promise<PlanShape> {
  return rpc(endpoint, "plan.read", { plan }) as Promise<PlanShape>;
}

async function admit(endpoint: string, checkUri: string, attemptKey: string, reobserve = false): Promise<Admission> {
  return rpc(endpoint, "check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey,
    checkUri,
    ...(reobserve ? { reobserve: true } : {}),
  }) as Promise<Admission>;
}

async function facts(endpoint: string, admission: Admission, values: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  await rpc(endpoint, "check.attempt.facts", {
    contract: "trust.fact-batch-request@1",
    attemptKey: admission.attemptKey,
    attemptHandle: admission.attemptHandle,
    executionId: admission.executionId,
    checkUri: admission.checkUri,
    recordedAt: now,
    facts: [{ kind: admission.operation.operation, observedAt: now, values }],
  });
}

async function finalize(endpoint: string, attemptHandle: string): Promise<void> {
  await rpc(endpoint, "check.attempt.finalize", {
    contract: "trust.attempt-finalization-request@1",
    attemptHandle,
  });
}

interface StreamEvent {
  readonly id: string;
  readonly type: string;
  readonly plan?: string;
  readonly resync?: true;
  readonly cause?: string;
  readonly workState?: string;
  readonly session?: { readonly state: string };
}

function defined<T>(value: T | null | undefined, label: string): T {
  assert.ok(value !== undefined && value !== null, `${label} is missing`);
  return value;
}

async function openPlanEvents(
  endpoint: string,
  lastEventId?: string,
): Promise<{
  takeUntil(predicate: (event: StreamEvent) => boolean): Promise<readonly StreamEvent[]>;
  close(): void;
}> {
  const controller = new AbortController();
  const response = await fetch(`${endpoint}/events/plans`, {
    signal: controller.signal,
    ...(lastEventId === undefined ? {} : { headers: { "last-event-id": lastEventId } }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async takeUntil(predicate) {
      const events: StreamEvent[] = [];
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (!data) continue;
          const event = JSON.parse(data) as StreamEvent;
          events.push(event);
          if (predicate(event)) return events;
        }
      }
      assert.fail("Plan event stream did not reach the expected event");
    },
    close() {
      controller.abort();
    },
  };
}

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}

async function rpcFailure(
  endpoint: string,
  method: string,
  params: unknown,
): Promise<{
  data?: { reason?: string; message?: string };
}> {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.notEqual(envelope.error, undefined);
  return envelope.error as { data?: { reason?: string; message?: string } };
}

async function rpcEnvelope(
  endpoint: string,
  method: string,
  params: unknown,
): Promise<{
  result?: unknown;
  error?: unknown;
}> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ result?: unknown; error?: unknown }>;
}
