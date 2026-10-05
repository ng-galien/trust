import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckView, PlanView } from "@trust/extension-sdk";
import { test } from "./support/fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const operationsDirectory = path.join(repositoryRoot, "assets/operations");

interface Admission {
  status: string;
  attemptKey: string;
  attemptHandle: string;
  executionId: string;
  checkUri: string;
  operation: { operation: string };
}

test("concurrent publication, engagement and replay preserve one history and exact external instants", async ({
  startRuntime,
}) => {
  const runtime = await startRuntime("trust-storage-replay-", {
    operationsDirectory,
    environments: { local: {} },
  });
  const source = await readFile(path.join(repositoryRoot, "assets/procedures/00-git-status.feature"), "utf8");
  const publications = await Promise.all(
    Array.from({ length: 8 }, () =>
      rpc(runtime.endpoint, "procedure.publish", { source, sourceName: "git-status.feature" }),
    ),
  );
  for (const publication of publications) assert.deepEqual(publication, publications[0]);
  const request = {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan: "concurrent-replay",
    environment: "local",
    mode: "dry-run",
    rootInputs: { repository: "repository" },
  };
  const engaged = await Promise.all(
    Array.from({ length: 8 }, () => rpc<{ checkUris: string[] }>(runtime.endpoint, "plan.engage", request)),
  );
  for (const value of engaged) assert.deepEqual(value, engaged[0]);
  const checkUri = engaged[0]!.checkUris[0]!;
  for (const [method, params, reason] of [
    [
      "check.attempt.finalize",
      { contract: "trust.attempt-finalization-request@1", attemptHandle: "missing-attempt" },
      "attempt-not-found",
    ],
    [
      "check.attempt.interrupt",
      { contract: "trust.attempt-interruption-request@1", attemptHandle: "missing-attempt" },
      "attempt-not-found",
    ],
    [
      "check.escalate",
      {
        contract: "trust.check-escalation-request@1",
        checkUri,
        attemptHandle: "missing-attempt",
        blockingReason: "Missing observation",
        forbiddenFurtherAction: "Invent Facts",
      },
      "check-not-escalatable",
    ],
    [
      "plan.resume",
      { plan: request.plan, escalationId: "missing-escalation", resumeReason: "Review complete" },
      "plan-conflict",
    ],
  ] as const) {
    const failure = await rpcEnvelope(runtime.endpoint, method, params);
    assert.equal(failure.error?.data?.reason, reason);
  }

  const admissions = await Promise.all(
    ["first", "second"].map((attemptKey) => admit(runtime.endpoint, checkUri, attemptKey)),
  );
  assert.ok(admissions.every(({ status }) => status === "ADMITTED"));
  const observedAt = "2026-09-25T12:13:14.123456+02:00";
  const recordedAt = "2026-09-25T12:13:15.654321+02:00";
  const receipts = await Promise.all(
    admissions.map((admission) =>
      rpc<{ acceptedFactIds: string[] }>(
        runtime.endpoint,
        "check.attempt.facts",
        batch(admission, "clean", observedAt, recordedAt),
      ),
    ),
  );
  assert.deepEqual(receipts[0]!.acceptedFactIds, receipts[1]!.acceptedFactIds);
  const results = await Promise.all(admissions.map((admission) => finalize(runtime.endpoint, admission.attemptHandle)));
  assert.ok(results.every(({ verdict }) => verdict === "NOT_VALIDATED"));
  const check = await rpc<CheckView>(runtime.endpoint, "check.read", {
    contract: "trust.check-read-request@1",
    checkUri,
  });
  assert.equal(check.history.length, 1);
  assert.equal(check.attempts.length, 2);
  for (const attempt of check.attempts) {
    assert.equal(attempt.facts.length, 1);
    assert.equal(attempt.facts[0]!.observedAt, observedAt);
    assert.equal(attempt.facts[0]!.recordedAt, recordedAt);
  }
  const replays = await Promise.all(admissions.map((admission) => finalize(runtime.endpoint, admission.attemptHandle)));
  const storedOutcome = ({ next: _next, ...stored }: { verdict: string; next?: unknown }) => stored;
  assert.deepEqual(replays.map(storedOutcome), results.map(storedOutcome));
  const plan = await rpc<PlanView>(runtime.endpoint, "plan.read", { plan: request.plan });
  assert.equal(plan.sessions.filter(({ state }) => state === "open").length, 1);
});

test("distinct Checks finalize concurrently without losing a qualification or exposing a partial Plan", async ({
  startRuntime,
}) => {
  const runtime = await startRuntime("trust-storage-two-checks-", {
    operationsDirectory,
    environments: { local: {} },
  });
  const source = `# language: en
@trust-dsl:1 @procedure:storage-concurrency @version:1.0.0
Feature: Observe two independent repository Checks
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repository state. | Change repository state. |
    Given one reference "repository"
  @scenario:first
  Scenario: First
    Then Check "first" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "first read"
      """js
      fact.workingTree === "dirty" || fail("not dirty")
      """
  @scenario:second
  Scenario: Second
    Then Check "second" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "second read"
      """js
      fact.workingTree === "dirty" || fail("not dirty")
      """
`;
  await rpc(runtime.endpoint, "procedure.publish", { source, sourceName: "storage-concurrency.feature" });
  const engaged = await rpc<{ checkUris: string[] }>(runtime.endpoint, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "storage-concurrency",
    procedureVersion: "1.0.0",
    plan: "two-checks",
    environment: "local",
    mode: "dry-run",
    rootInputs: { repository: "repository" },
  });
  const admissions = await Promise.all(
    engaged.checkUris.map((uri, index) => admit(runtime.endpoint, uri, `two-${index}`)),
  );
  assert.equal(admissions.length, 2);
  await Promise.all(
    admissions.map((admission) => rpc(runtime.endpoint, "check.attempt.facts", batch(admission, "dirty"))),
  );
  const [results, views] = await Promise.all([
    Promise.all(admissions.map((admission) => finalize(runtime.endpoint, admission.attemptHandle))),
    Promise.all(Array.from({ length: 6 }, () => rpc<PlanView>(runtime.endpoint, "plan.read", { plan: "two-checks" }))),
  ]);
  assert.ok(results.every(({ verdict }) => verdict === "VALIDATED"));
  for (const view of views) assert.equal(view.satisfiedChecks + view.openChecks.length, 2);
  const complete = await rpc<PlanView>(runtime.endpoint, "plan.read", { plan: "two-checks" });
  assert.equal(complete.workState, "COMPLETE");
  assert.equal(complete.satisfiedChecks, 2);
  assert.equal(complete.revisions.length, 3);
});

function batch(
  admission: Admission,
  workingTree: string,
  observedAt = "2026-09-25T10:00:00Z",
  recordedAt = "2026-09-25T10:00:01Z",
) {
  return {
    contract: "trust.fact-batch-request@1",
    attemptKey: admission.attemptKey,
    attemptHandle: admission.attemptHandle,
    executionId: admission.executionId,
    checkUri: admission.checkUri,
    recordedAt,
    facts: [{ kind: admission.operation.operation, observedAt, values: { headRevision: "revision-a", workingTree } }],
  };
}

function admit(endpoint: string, checkUri: string, attemptKey: string): Promise<Admission> {
  return rpc(endpoint, "check.attempt.admit", { contract: "trust.check-admission-request@1", checkUri, attemptKey });
}

function finalize(endpoint: string, attemptHandle: string): Promise<{ verdict: string }> {
  return rpc(endpoint, "check.attempt.finalize", { contract: "trust.attempt-finalization-request@1", attemptHandle });
}

async function rpc<T = unknown>(endpoint: string, method: string, params: unknown): Promise<T> {
  const envelope = await rpcEnvelope<T>(endpoint, method, params);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}

async function rpcEnvelope<T = unknown>(
  endpoint: string,
  method: string,
  params: unknown,
): Promise<{ result: T; error?: { data?: { reason?: string } } }> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ result: T; error?: { data?: { reason?: string } } }>;
}
