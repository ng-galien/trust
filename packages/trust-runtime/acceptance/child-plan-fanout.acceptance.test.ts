import assert from "node:assert/strict";
import type { AttemptFinalizationResult, CheckAttemptAdmissionResult, CheckView, PlanView } from "@trust/extension-sdk";
import { test } from "./support/fixtures.js";

const width = 41;
const childSource = `@trust-dsl:1 @procedure:fanout-child @version:1.0.0
Feature: Return an observed revision
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repository state. | Change repository state. |
    And one reference "repository"
    And one reference "revision" returned
  @scenario:observe
  Scenario: Observe the repository
    Then Check "observe" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and materializes "revision" from field "headRevision" and must establish "the revision is accepted"
      """js
      fact.workingTree === "clean" || fail("the working tree is not clean")
      """
`;
const parentSource = `@trust-dsl:1 @procedure:fanout-parent @version:1.0.0
Feature: Govern a wide set of child Results
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repository state. | Change repository state. |
    And one reference "repository"
${Array.from({ length: width }, (_, index) => `    And one reference "revision ${index}"`).join("\n")}
  @scenario:prerequisite
  Scenario: Accept the prerequisite
    Then Check "prerequisite" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "work may proceed"
      """js
      fact.workingTree === "clean" || fail("the prerequisite is not accepted")
      """
  @scenario:independent
  Scenario: Preserve independent work
    Then Invocation "independent" runs Procedure "fanout-child@1.0.0" on "repository" as Input "repository" and must establish "independent work is complete"
  @scenario:batch
  Scenario: Collect the child Results
    Given scenario "prerequisite" is validated
${Array.from({ length: width }, (_, index) => `    ${index === 0 ? "Then" : "And"} Invocation "work ${index}" runs Procedure "fanout-child@1.0.0" on "repository" as Input "repository" and materializes "revision ${index}" from Result "revision" and must establish "the child Result is accepted"`).join("\n")}
  @scenario:downstream
  Scenario: Use the completed batch
    Given scenario "batch" is validated
    Then Invocation "downstream" runs Procedure "fanout-child@1.0.0" on "repository" as Input "repository" and must establish "downstream work is complete"
    And Check "compare" runs Operation "git.head-compare@1.0.0" on "repository" as Input "project" using "revision 0" as Input "baseRevision" and must establish "the accepted revision is compared"
      """js
      fact.comparedBaseRevision === context["revision 0"] || fail("another revision was compared")
      """
`;

test("43 children retain independent qualifications and invalidate dependent work after requalification", {
  // More than 45 serial governed transitions; every RPC retains its own 30-second limit.
  timeout: 300_000,
}, async ({ runtime }) => {
  let sequence = 0;
  const durations = new Map<string, number[]>();
  const rpc = async <T = unknown>(method: string, params: unknown): Promise<T> => {
    const started = performance.now();
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      signal: AbortSignal.timeout(30_000),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    const envelope = (await response.json()) as { result: T; error?: unknown };
    const elapsed = durations.get(method) ?? [];
    elapsed.push(performance.now() - started);
    durations.set(method, elapsed);
    assert.equal(envelope.error, undefined, `${method}: ${JSON.stringify(envelope.error)}`);
    return envelope.result;
  };
  const read = (plan = "fanout-root") => rpc<PlanView>("plan.read", { plan });
  const reportTimings = (phase: string) => {
    console.info(
      "Fan-out RPC timings",
      phase,
      JSON.stringify(
        Object.fromEntries(
          [...durations].map(([method, values]) => [
            method,
            {
              calls: values.length,
              totalMs: Math.round(values.reduce((sum, value) => sum + value, 0)),
              maxMs: Math.round(Math.max(...values)),
            },
          ]),
        ),
      ),
    );
  };
  const childPlan = (view: PlanView, name: string): string => {
    const slug = view.invocations.find((value) => value.name === name)?.childPlan;
    assert.ok(slug, `expected an active child for ${name}`);
    return slug;
  };
  const finish = async (plan: string, name: string, headRevision: string, workingTree = "clean", reobserve = false) => {
    const check = (await read(plan)).checks.find((value) => value.name === name);
    assert.ok(check);
    const attempt = await rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: check.checkUri,
      attemptKey: `fanout-${++sequence}`,
      ...(reobserve ? { reobserve: true } : {}),
    });
    assert.equal(attempt.status, "ADMITTED", JSON.stringify(attempt));
    const observedAt = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptKey: attempt.attemptKey,
      attemptHandle: attempt.attemptHandle,
      executionId: attempt.executionId,
      checkUri: attempt.checkUri,
      recordedAt: observedAt,
      facts: [
        {
          kind: attempt.operation.operation,
          observedAt,
          values:
            name === "compare"
              ? { headRevision, workingTree, comparedBaseRevision: headRevision, commitsAhead: 0 }
              : { headRevision, workingTree },
        },
      ],
    });
    const result = await rpc<AttemptFinalizationResult>("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: attempt.attemptHandle,
    });
    assert.equal(result.verdict, workingTree === "clean" ? "VALIDATED" : "NOT_VALIDATED");
    return check.checkUri;
  };

  await rpc("procedure.publish", { source: childSource });
  await rpc("procedure.publish", { source: parentSource });
  await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "fanout-parent",
    procedureVersion: "1.0.0",
    plan: "fanout-root",
    environment: "local",
    mode: "dry-run",
    rootInputs: { repository: "repository" },
  });
  const initial = await read();
  reportTimings("engaged");
  assert.equal(initial.invocations.length, 43);
  assert.equal(initial.invocations.filter((value) => value.childPlan).length, 1);
  const independent = childPlan(initial, "independent");
  await finish(independent, "observe", "independent-revision");
  await finish("fanout-root", "prerequisite", "prerequisite-one");
  const opened = await read();
  reportTimings("batch opened");
  const workers = opened.invocations.filter((value) => value.scenario === "batch");
  assert.equal(workers.length, width);
  assert.ok(workers.every((value) => value.childPlan && value.generation === 1));
  assert.equal(opened.invocations.find((value) => value.name === "downstream")?.childPlan, null);

  // Serial public finalizations exercise a wide composition without manufacturing pool saturation.
  let completedWorkers = 0;
  for (const worker of workers) {
    await finish(childPlan(opened, worker.name), "observe", `${worker.name}-revision`);
    if (++completedWorkers % 10 === 0) reportTimings(`${completedWorkers} Results imported`);
  }
  const collected = await read();
  assert.equal(collected.importedResults.length, width);
  assert.equal(collected.invocations.filter((value) => value.childPlan).length, 43);
  assert.ok(
    collected.invocations.filter((value) => value.scenario === "batch").every((value) => value.state === "SATISFIED"),
  );
  const downstream = childPlan(collected, "downstream");
  const firstWorker = childPlan(opened, "work 0");
  const firstRevision = "work 0-revision";
  assert.equal(collected.checks.find((value) => value.name === "compare")?.inputs.baseRevision, firstRevision);
  await finish(downstream, "observe", "downstream-revision");
  await finish("fanout-root", "compare", firstRevision);
  assert.equal((await read()).checklistComplete, true);

  const childCheckUri = await finish(firstWorker, "observe", "corrected-revision", "clean", true);
  const corrected = await read();
  assert.equal(corrected.importedResults.find((value) => value.role === "revision 0")?.value, "corrected-revision");
  assert.equal(corrected.checks.find((value) => value.name === "compare")?.state, "OPEN");
  assert.equal(corrected.checks.find((value) => value.name === "compare")?.inputs.baseRevision, "corrected-revision");
  assert.equal(corrected.invocations.find((value) => value.name === "independent")?.childPlan, independent);
  assert.equal(corrected.invocations.find((value) => value.name === "independent")?.state, "SATISFIED");
  const history = await rpc<CheckView>("check.read", {
    contract: "trust.check-read-request@1",
    checkUri: childCheckUri,
  });
  assert.equal(history.history.length, 2);

  await finish("fanout-root", "prerequisite", "prerequisite-rejected", "dirty", true);
  const withdrawn = await read();
  assert.deepEqual(withdrawn.importedResults, []);
  assert.ok(
    withdrawn.invocations
      .filter((value) => value.scenario === "batch")
      .every(
        (value) => value.childPlan === null && value.history.length === 1 && value.history[0]?.supersededAt !== null,
      ),
  );
  assert.equal(withdrawn.invocations.find((value) => value.name === "downstream")?.childPlan, null);
  assert.equal(withdrawn.invocations.find((value) => value.name === "independent")?.state, "SATISFIED");
  assert.equal(withdrawn.checklistComplete, false);
  assert.equal(
    withdrawn.checks.some((value) => value.name === "compare"),
    false,
  );
  const obsolete = await rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    checkUri: childCheckUri,
    attemptKey: `fanout-obsolete-${++sequence}`,
    reobserve: true,
  });
  assert.equal(obsolete.status, "REFUSED");

  // Report end-to-end cost without a machine-dependent millisecond pass/fail threshold.
  reportTimings("complete");
});
