import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CheckAttemptAdmissionResult, CheckFinalizationResult, PlanView } from "@trust/extension-sdk";

// The file runs compiled from dist/acceptance or directly as TypeScript from acceptance; both use the built runtime.
const here = path.dirname(fileURLToPath(import.meta.url));
const runtimePackage = path.resolve(here, here.endsWith(`${path.sep}dist${path.sep}acceptance`) ? "../.." : "..");
const root = path.resolve(runtimePackage, "../..");
const { startPublicRuntime } = (await import(
  pathToFileURL(path.join(runtimePackage, "dist/acceptance/support/runtime-process.js")).href
)) as typeof import("./support/runtime-process.js");
const parentSource = `@trust-dsl:1 @procedure:mission-removal-parent @version:1.0.0
Feature: Remove accepted work that never ran
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repositories. | Change external state. |
    And missions "work" declared by agent
  @scenario:work
  Scenario: Execute declared work
    Then Invocation "execute-work" runs each declared Procedure in "work" and must establish "declared work completed"
`;
const childSource = `@trust-dsl:1 @procedure:mission-removal-child @version:1.0.0
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
  definition: { kind: "published", reference: "mission-removal-child@1.0.0" },
  rootInputs: { repository: `${id}-repository` },
});

/** One disposable runtime with a dry-run parent Plan whose "work" collection holds the given missions. */
async function setup(plan: string, missions: readonly ReturnType<typeof mission>[]) {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-mission-removal-"));
  const runtime = await startPublicRuntime("trust-mission-removal-", {
    storage: { kind: "pglite" as const, directory: path.join(directory, "pglite") },
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root } },
  });
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
    procedure: "mission-removal-parent",
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
  /** Admit one Attempt on the child's Check; with `complete`, submit a passing Fact and finalize it. */
  const attempt = async (child: string, complete: boolean) => {
    const check = (await read(child)).checks[0];
    assert.ok(check);
    const admitted = await rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: check.checkUri,
      attemptKey: `attempt-${child}`,
    });
    assert.equal(admitted.status, "ADMITTED", JSON.stringify(admitted));
    if (!complete) return;
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
  return {
    request,
    rpc,
    read,
    replacement,
    childOf,
    attempt,
    async close() {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("CXP-230 AC1 a declarations replacement removes a mission whose child Plan admitted no Attempt and the parent no longer requires it", {
  timeout: 30_000,
}, async () => {
  const fixture = await setup("removal-accepted", [mission("delivered-work"), mission("unrun-work")]);
  try {
    await fixture.attempt(await fixture.childOf("delivered-work"), true);
    const unrun = await fixture.childOf("unrun-work");
    const before = await fixture.read();
    assert.notEqual(before.workState, "COMPLETE", "the parent waits for the mission that never ran");

    await fixture.rpc("plan.declarations.replace", await fixture.replacement([mission("delivered-work")]));
    const after = await fixture.read();
    assert.equal(after.revision > before.revision, true);
    assert.deepEqual(
      after.missionDeclarations?.work?.map((value) => value.id),
      ["delivered-work"],
    );
    assert.deepEqual(
      after.resolvedMissions?.work?.map((value) => value.id),
      ["delivered-work"],
    );
    assert.deepEqual(
      after.invocations.map((invocation) => invocation.mission?.id),
      ["delivered-work"],
      "the parent composition no longer counts the removed mission",
    );
    assert.equal(after.workState, "COMPLETE", "the parent no longer requires the removed child Plan");
    const removedChild = await fixture.read(unrun);
    assert.equal(removedChild.parent?.current, false, "the removed child Plan is a superseded generation");
  } finally {
    await fixture.close();
  }
});

test("CXP-230 AC2 the removal is refused when the child Plan admitted an Attempt", {
  timeout: 30_000,
}, async () => {
  const fixture = await setup("removal-refused", [mission("kept-work"), mission("started-work")]);
  try {
    await fixture.attempt(await fixture.childOf("started-work"), false);
    const before = await fixture.read();
    const refused = await fixture.request(
      "plan.declarations.replace",
      await fixture.replacement([mission("kept-work")]),
    );
    assert.ok(refused.error, JSON.stringify(refused));
    assert.match(
      JSON.stringify(refused.error),
      /Accepted mission \\"started-work\\" cannot be removed: its child Plan admitted an Attempt/,
    );
    const after = await fixture.read();
    assert.equal(after.revision, before.revision, "a refused replacement changes nothing");
    assert.deepEqual(after.invocations, before.invocations);

    // A modified accepted mission is still refused, whether or not its child ran.
    const modified = await fixture.request(
      "plan.declarations.replace",
      await fixture.replacement([
        { ...mission("kept-work"), rootInputs: { repository: "other" } },
        mission("started-work"),
      ]),
    );
    assert.match(JSON.stringify(modified.error), /Accepted mission \\"kept-work\\" cannot be modified/);
    assert.equal((await fixture.read()).revision, before.revision);
  } finally {
    await fixture.close();
  }
});

test("CXP-230 AC3 the revision history of the parent Plan keeps the removed mission", {
  timeout: 30_000,
}, async () => {
  const fixture = await setup("removal-history", [mission("kept-work"), mission("removed-work")]);
  try {
    const accepted = (await fixture.read()).revision;
    const removedChild = await fixture.childOf("removed-work");
    await fixture.rpc("plan.declarations.replace", await fixture.replacement([mission("kept-work")]));
    const current = await fixture.read();
    const earlier = current.revisions.find((revision) => revision.revision === accepted);
    assert.ok(earlier, "the revision that accepted the mission is still in the history");
    assert.deepEqual(
      earlier.missionDeclarations?.work?.map((value) => value.id),
      ["kept-work", "removed-work"],
    );
    const latest = current.revisions.find((revision) => revision.revision === current.revision);
    assert.deepEqual(
      latest?.missionDeclarations?.work?.map((value) => value.id),
      ["kept-work"],
    );
    // The removed child Plan stays readable as a superseded generation of the parent.
    const child = await fixture.read(removedChild);
    assert.equal(child.parent?.plan, "removal-history");
    assert.equal(child.parent?.current, false);
  } finally {
    await fixture.close();
  }
});
