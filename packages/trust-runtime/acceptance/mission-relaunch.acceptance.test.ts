import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  CheckAttemptAdmissionResult,
  CheckFinalizationResult,
  PlanCancellationResult,
  PlanRelaunchResult,
  PlanView,
} from "@trust/extension-sdk";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const parentSource = `@trust-dsl:1 @procedure:relaunch-orchestration @version:1.0.0
Feature: Relaunch an escalated mission as a new generation
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repositories. | Change external state. |
    And missions "work" declared by agent
  @scenario:work
  Scenario: Execute declared work
    Then Invocation "execute-work" runs each declared Procedure in "work" and must establish "declared work completed"
`;

const childSource = `@trust-dsl:1 @procedure:relaunch-mission @version:1.0.0
Feature: Observe the delegated repository
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the repository. | Modify the repository or qualification criteria. |
    And one reference "repository"
  @scenario:observe
  Scenario: Observe
    Then Check "diagnostic" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "the diagnostic is available"
      """js
      fact.workingTree === "clean" || fail("the repository is dirty")
      """
`;

const mission = {
  id: "observe-repository",
  definition: { kind: "published", reference: "relaunch-mission@^1.0.0" },
  rootInputs: { repository: "relaunched-repository" },
};

test("an escalated mission is relaunched as the next generation of the same invocation and completes its parent", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-mission-relaunch-"));
  const options = {
    storage: { kind: "pglite" as const, directory: path.join(directory, "pglite") },
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root } },
  };
  let runtime = await startPublicRuntime("trust-mission-relaunch-", options);
  const request = async <T>(method: string, params: unknown): Promise<{ result?: T; error?: { message?: string } }> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ result?: T; error?: { message?: string } }>;
  };
  const rpc = async <T = unknown>(method: string, params: unknown): Promise<T> => {
    const envelope = await request<T>(method, params);
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result as T;
  };
  const read = (plan: string) => rpc<PlanView>("plan.read", { plan });
  let sequence = 0;
  const observe = async (plan: string, workingTree: "clean" | "dirty") => {
    const check = (await read(plan)).checks.find((candidate) => candidate.name === "diagnostic");
    assert.ok(check?.actionable, `diagnostic is actionable in ${plan}`);
    const attempt = await rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: check.checkUri,
      attemptKey: `relaunch-${++sequence}`,
    });
    assert.equal(attempt.status, "ADMITTED", JSON.stringify(attempt));
    const observedAt = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptHandle: attempt.attemptHandle,
      attemptKey: attempt.attemptKey,
      executionId: attempt.executionId,
      checkUri: attempt.checkUri,
      recordedAt: observedAt,
      facts: [
        { kind: attempt.operation.operation, observedAt, values: { workingTree, headRevision: `head-${sequence}` } },
      ],
    });
    return rpc<CheckFinalizationResult>("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: attempt.attemptHandle,
    });
  };

  try {
    await rpc("procedure.publish", { source: childSource });
    await rpc("procedure.publish", { source: parentSource });
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "relaunch-orchestration",
      procedureVersion: "1.0.0",
      plan: "relaunch-root",
      mode: "dry-run",
      environment: "local",
      rootInputs: {},
    });
    await rpc("plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "relaunch-root",
      expectedRevision: (await read("relaunch-root")).revision,
      declarations: {},
      missionDeclarations: { work: [mission] },
    });
    const firstChild = (await read("relaunch-root")).invocations[0]?.childPlan;
    assert.ok(firstChild);

    // The first generation fails its qualification and is escalated: the parent cannot complete.
    assert.equal((await observe(firstChild, "dirty")).verdict, "NOT_VALIDATED");
    const blocked = (await read(firstChild)).checks[0];
    assert.ok(blocked?.escalatable && blocked.attemptHandle);
    await rpc("check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: blocked.checkUri,
      attemptHandle: blocked.attemptHandle,
      blockingReason: "The repository observed by this generation cannot satisfy the mission.",
      forbiddenFurtherAction: "Change the qualification criteria to manufacture success.",
    });
    const escalationId = (await read(firstChild)).activeEscalation?.escalationId;
    assert.ok(escalationId);
    assert.equal((await read("relaunch-root")).descendantEscalations.length, 1);

    // Only the active escalation of a current child generation can be relaunched, with an audit reason.
    const rootRefused = await request("plan.relaunch", {
      plan: "relaunch-root",
      escalationId,
      relaunchReason: "Not a child.",
    });
    assert.match(JSON.stringify(rootRefused.error), /not a child invocation/u);
    const wrongEscalation = await request("plan.relaunch", {
      plan: firstChild,
      escalationId: "00000000-0000-4000-8000-000000000000",
      relaunchReason: "Unknown escalation.",
    });
    assert.ok(wrongEscalation.error, "an unknown escalation is refused");
    const blankReason = await request("plan.relaunch", { plan: firstChild, escalationId, relaunchReason: "  " });
    assert.ok(blankReason.error, "a relaunch requires an audit reason");

    const relaunch = {
      plan: firstChild,
      escalationId,
      relaunchReason: "The mission is replayed on a narrowed verification closure.",
    };
    const relaunched = await rpc<PlanRelaunchResult>("plan.relaunch", relaunch);
    assert.equal(relaunched.contract, "trust.plan-relaunch@1");
    assert.equal(relaunched.status, "RELAUNCHED");
    assert.equal(relaunched.parentPlan, "relaunch-root");
    assert.equal(relaunched.supersededGeneration, 1);
    assert.equal(relaunched.generation, 2);
    assert.notEqual(relaunched.childPlan, firstChild);
    assert.deepEqual(
      await rpc("plan.relaunch", relaunch),
      relaunched,
      "a replayed relaunch returns the same generation",
    );

    // The parent now points to the new generation and keeps the abandoned one as history only.
    const parent = await read("relaunch-root");
    assert.equal(parent.descendantEscalations.length, 0);
    const invocation = parent.invocations[0];
    assert.equal(invocation?.childPlan, relaunched.childPlan);
    assert.equal(invocation?.generation, 2);
    assert.deepEqual(
      invocation?.history.map((entry) => [entry.generation, entry.childPlan, entry.supersededAt !== null]),
      [
        [1, firstChild, true],
        [2, relaunched.childPlan, false],
      ],
    );
    const abandoned = await read(firstChild);
    assert.equal(abandoned.activeEscalation, null);
    assert.match(abandoned.escalations[0]?.resumeReason ?? "", /Relaunched as a new invocation generation/u);
    const refused = await rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: abandoned.checks[0]!.checkUri,
      attemptKey: "abandoned-generation",
    });
    assert.equal(refused.status, "REFUSED", "the abandoned generation admits no further Check");

    // The Plan of the relaunched generation does not stay in progress: TRUST cancels it with the relaunch reason.
    assert.equal(abandoned.workState, "CANCELLED");
    assert.match(abandoned.cancellation?.reason ?? "", /Relaunched as a new invocation generation/u);
    const current = await request("plan.cancel", {
      plan: relaunched.childPlan,
      reason: "Not a superseded generation.",
    });
    assert.ok(current.error, "a current child Plan is cancelled through its root Plan or its mission");

    // The next generation runs the same pinned definition and inputs, and completes the parent.
    const next = await read(relaunched.childPlan);
    assert.equal(next.procedure, "relaunch-mission");
    assert.equal(next.procedureVersion, "1.0.0");
    assert.deepEqual(next.rootInputs, mission.rootInputs);
    assert.equal((await observe(relaunched.childPlan, "clean")).verdict, "VALIDATED");
    assert.equal((await read("relaunch-root")).invocations[0]?.state, "SATISFIED");

    await runtime.close();
    runtime = await startPublicRuntime("trust-mission-relaunch-", options);
    const restored = await read("relaunch-root");
    assert.equal(restored.invocations[0]?.childPlan, relaunched.childPlan);
    assert.equal(restored.invocations[0]?.state, "SATISFIED");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
