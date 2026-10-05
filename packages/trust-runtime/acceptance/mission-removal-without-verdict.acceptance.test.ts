import assert from "node:assert/strict";
import type { CheckAttemptAdmissionResult, CheckFinalizationResult, PlanView } from "@trust/extension-sdk";
import { catalogOperationsDirectory, repositoryRoot, test } from "./support/fixtures.js";

const parentSource = `@trust-dsl:1 @procedure:removal-verdict-parent @version:1.0.0
Feature: Remove accepted work that gave no verdict
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repositories. | Change external state. |
    And missions "work" declared by agent
  @scenario:work
  Scenario: Execute declared work
    Then Invocation "execute-work" runs each declared Procedure in "work" and must establish "declared work completed"
`;
const childSource = `@trust-dsl:1 @procedure:removal-verdict-child @version:1.0.0
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
const mission = (id: string) => ({
  id,
  definition: { kind: "published", reference: "removal-verdict-child@1.0.0" },
  rootInputs: { repository: `${id}-repository` },
});
type Admitted = Extract<CheckAttemptAdmissionResult, { status: "ADMITTED" }>;

/** One dry-run parent Plan on the given runtime, whose "work" collection holds the given missions. */
async function setup(endpoint: string, plan: string, missions: readonly ReturnType<typeof mission>[]) {
  const request = async <T>(method: string, params: unknown): Promise<{ result?: T; error?: { message?: string } }> => {
    const response = await fetch(`${endpoint}/rpc`, {
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
  const read = (slug = plan) => rpc<PlanView>("plan.read", { plan: slug });
  const replacement = async (work: readonly unknown[]) => ({
    contract: "trust.plan-declaration-replacement-request@1",
    plan,
    expectedRevision: (await read()).revision,
    declarations: {},
    missionDeclarations: { work },
  });
  await rpc("procedure.publish", { source: childSource });
  await rpc("procedure.publish", { source: parentSource });
  await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "removal-verdict-parent",
    procedureVersion: "1.0.0",
    plan,
    mode: "dry-run",
    environment: "local",
    rootInputs: {},
  });
  await rpc("plan.declarations.replace", await replacement(missions));
  const childOf = async (id: string) => {
    const child = (await read()).invocations.find((invocation) => invocation.mission?.id === id)?.childPlan;
    assert.ok(child, `mission ${id} has a child Plan`);
    return child;
  };
  /** Admit one Attempt on the child's Check and leave it pending. */
  const admit = async (child: string): Promise<Admitted> => {
    const check = (await read(child)).checks[0];
    assert.ok(check);
    const admitted = await rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: check.checkUri,
      attemptKey: `attempt-${child}`,
    });
    assert.equal(admitted.status, "ADMITTED", JSON.stringify(admitted));
    return admitted as Admitted;
  };
  /** Submit a passing Fact for an admitted Attempt and finalize it with a verdict. */
  const finalize = async (admitted: Admitted) => {
    const observedAt = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptHandle: admitted.attemptHandle,
      attemptKey: admitted.attemptKey,
      executionId: admitted.executionId,
      checkUri: admitted.checkUri,
      recordedAt: observedAt,
      facts: [
        { kind: admitted.operation.operation, observedAt, values: { workingTree: "clean", headRevision: "head" } },
      ],
    });
    const finalized = await rpc<CheckFinalizationResult>("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: admitted.attemptHandle,
    });
    assert.equal(finalized.verdict, "VALIDATED");
  };
  const attemptState = async (admitted: Admitted) => {
    const check = await rpc<{ attempts: readonly { state: string }[] }>("check.read", {
      contract: "trust.check-read-request@1",
      checkUri: admitted.checkUri,
    });
    return check.attempts[0]?.state;
  };
  return {
    request,
    rpc,
    read,
    replacement,
    childOf,
    admit,
    finalize,
    attemptState,
  };
}

test("CXP-240 AC1 the removal is accepted when every Attempt of the child Plan and its descendants has no verdict and none is running", {
  timeout: 30_000,
}, async ({ startRuntime }) => {
  // Its own runtime: its Sessions last three seconds, so that a pending Attempt expires during the test.
  const runtime = await startRuntime("trust-removal-verdict-", {
    operationsDirectory: catalogOperationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
    sessionDurationMs: 3_000,
  });
  const fixture = await setup(runtime.endpoint, "removal-without-verdict", [
    mission("kept-work"),
    mission("interrupted-work"),
    mission("expired-work"),
  ]);
  const interrupted = await fixture.admit(await fixture.childOf("interrupted-work"));
  await fixture.rpc("check.attempt.interrupt", {
    contract: "trust.attempt-interruption-request@1",
    attemptHandle: interrupted.attemptHandle,
  });
  assert.equal(await fixture.attemptState(interrupted), "interrupted");
  const expired = await fixture.admit(await fixture.childOf("expired-work"));
  const remaining = Date.parse(expired.expiresAt) - Date.now();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 200));
  assert.equal(await fixture.attemptState(expired), "pending", "the expired Attempt was never finalized");
  assert.equal(Date.parse(expired.expiresAt) < Date.now(), true, "the pending Attempt is past its expiry");

  const before = await fixture.read();
  await fixture.rpc("plan.declarations.replace", await fixture.replacement([mission("kept-work")]));
  const after = await fixture.read();
  assert.equal(after.revision > before.revision, true);
  assert.deepEqual(
    after.missionDeclarations?.work?.map((value) => value.id),
    ["kept-work"],
  );
  assert.deepEqual(
    after.invocations.map((invocation) => invocation.mission?.id),
    ["kept-work"],
    "the parent composition no longer counts the removed missions",
  );
});

test("CXP-240 AC2 the removal is refused when an Attempt gave a verdict or when an Attempt is running and not expired", {
  timeout: 30_000,
}, async ({ runtime }) => {
  const fixture = await setup(runtime.endpoint, "removal-with-verdict", [
    mission("kept-work"),
    mission("verdict-work"),
    mission("running-work"),
  ]);
  await fixture.finalize(await fixture.admit(await fixture.childOf("verdict-work")));
  const running = await fixture.admit(await fixture.childOf("running-work"));
  assert.equal(await fixture.attemptState(running), "pending");
  assert.equal(Date.parse(running.expiresAt) > Date.now(), true, "the running Attempt is not expired");
  const before = await fixture.read();

  const verdict = await fixture.request(
    "plan.declarations.replace",
    await fixture.replacement([mission("kept-work"), mission("running-work")]),
  );
  assert.ok(verdict.error, JSON.stringify(verdict));
  assert.match(
    JSON.stringify(verdict.error),
    /Accepted mission \\"verdict-work\\" cannot be removed: an Attempt of its child Plan gave a verdict/,
  );

  const runningRefusal = await fixture.request(
    "plan.declarations.replace",
    await fixture.replacement([mission("kept-work"), mission("verdict-work")]),
  );
  assert.ok(runningRefusal.error, JSON.stringify(runningRefusal));
  assert.match(
    JSON.stringify(runningRefusal.error),
    /Accepted mission \\"running-work\\" cannot be removed: an Attempt of its child Plan is running and not expired/,
  );

  const after = await fixture.read();
  assert.equal(after.revision, before.revision, "a refused replacement changes nothing");
  assert.deepEqual(after.invocations, before.invocations);
});
