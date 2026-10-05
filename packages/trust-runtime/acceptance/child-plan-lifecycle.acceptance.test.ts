import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./support/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const parentSource = `@trust-dsl:1 @procedure:child-lifecycle @version:1.0.0 @intent-chaining
Feature: Independent children and guarded final validation
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe the repository. | Change external state. |
    And one reference "repository" declared by agent
    And one reference "stable"
  @scenario:children
  Scenario: Execute independent children
    Then Invocation "changing" runs Procedure "intent-chaining@1.0.0" on "repository" as Input "repository" and must establish "changing child complete"
    And Invocation "stable" runs Procedure "intent-chaining@1.0.0" on "stable" as Input "repository" and must establish "stable child complete"
  @scenario:independent
  Scenario: Parent independent work
    Then Check "independent" runs Operation "git.head-read@*" on "stable" as Input "project" and must establish "parent observation"
      """js
      fact.workingTree === "clean" || fail("not clean")
      """
  @scenario:final
  Scenario: Validate the complete parent
    Given scenario "children" is validated
    And scenario "independent" is validated
    Then Check "final" runs Operation "git.head-read@*" on "stable" as Input "project" and must establish "parent complete"
      """js
      fact.workingTree === "clean" || fail("not clean")
      """
`;

test("concurrent first engagement returns one child generation and refuses erasing composition history", {
  timeout: 30_000,
}, async ({ runtime }) => {
  const rpc = async (method: string, params: unknown): Promise<any> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return response.json();
  };
  assert.ok(
    (
      await rpc("procedure.publish", {
        source: await readFile(
          path.join(root, "packages/trust-runtime/acceptance/fixtures/intent-chaining.feature"),
          "utf8",
        ),
      })
    ).result,
  );
  assert.ok((await rpc("procedure.publish", { source: parentSource })).result);
  const engagement = {
    contract: "trust.plan-engagement-request@1",
    procedure: "child-lifecycle",
    procedureVersion: "1.0.0",
    plan: "concurrent-root",
    mode: "dry-run",
    environment: "local",
    rootInputs: { stable: "stable" },
  };
  const responses = await Promise.all(Array.from({ length: 8 }, () => rpc("plan.engage", engagement)));
  for (const response of responses) assert.equal(response.error, undefined, JSON.stringify(response.error));
  const initial = (await rpc("plan.read", { plan: "concurrent-root" })).result;
  const invocation = initial.invocations.find((value: any) => value.name === "stable");
  assert.equal(invocation.history.length, 1);
  assert.equal(invocation.generation, 1);
  assert.equal(initial.sessions.length, 1);
  assert.equal((await rpc("plan.read", { plan: invocation.childPlan })).result.sessions.length, 1);
  for (const plan of ["concurrent-root", invocation.childPlan]) {
    for (const method of ["plan.reset", "plan.remove"]) {
      const response = await rpc(method, { plan });
      assert.match(JSON.stringify(response.error), /plan-conflict/);
      assert.match(JSON.stringify(response.error), /child|composition|history/i);
      assert.ok((await rpc("plan.read", { plan })).result);
    }
  }
  assert.deepEqual((await rpc("plan.read", { plan: "concurrent-root" })).result.invocations, initial.invocations);
});

test("sibling pending intentions are isolated and superseded late results cannot qualify replacement", {
  timeout: 40_000,
}, async ({ runtime }) => {
  const rpc = async (method: string, params: unknown, failure = false): Promise<any> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      signal: AbortSignal.timeout(10_000),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const envelope = (await response.json()) as any;
    if (failure) {
      assert.ok(envelope.error);
      return envelope.error;
    }
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const read = (plan: string) => rpc("plan.read", { plan });
  const mcpRead = async (plan: string) => {
    const response = await fetch(`${runtime.endpoint}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "trust_plan_read", arguments: { plan } },
      }),
    });
    const envelope = (await response.json()) as any;
    assert.equal(envelope.error, undefined);
    assert.ok(!envelope.result.isError);
    return envelope.result.content[0].text as string;
  };
  let sequence = 0;
  const admit = async (plan: string, checkName: string, nextIntent?: string, extra: object = {}) => {
    await mcpRead(plan);
    const view = await read(plan);
    const check = view.checks.find((value: any) => value.name === checkName);
    const result = await rpc("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: check.checkUri,
      attemptKey: `lifecycle-${++sequence}`,
      ...(view.currentIntent ? { intent: view.currentIntent } : {}),
      ...(nextIntent ? { nextIntent } : {}),
      ...extra,
    });
    assert.equal(result.status, "ADMITTED", JSON.stringify(result));
    return result;
  };
  const finish = async (attempt: any, workingTree = "clean", failure = false) => {
    const observedAt = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptKey: attempt.attemptKey,
      attemptHandle: attempt.attemptHandle,
      executionId: attempt.executionId,
      checkUri: attempt.checkUri,
      recordedAt: observedAt,
      facts: [
        { kind: attempt.operation.operation, observedAt, values: { workingTree, headRevision: `head-${sequence}` } },
      ],
    });
    return rpc(
      "check.attempt.finalize",
      { contract: "trust.attempt-finalization-request@1", attemptHandle: attempt.attemptHandle },
      failure,
    );
  };
  const declare = async (repository: string) => {
    const current = await read("lifecycle-root");
    return rpc("plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "lifecycle-root",
      expectedRevision: current.revision,
      declarations: { repository },
    });
  };
  await rpc("procedure.publish", {
    source: await readFile(
      path.join(root, "packages/trust-runtime/acceptance/fixtures/intent-chaining.feature"),
      "utf8",
    ),
  });
  await rpc("procedure.publish", { source: parentSource });
  const engagement = {
    contract: "trust.plan-engagement-request@1",
    procedure: "child-lifecycle",
    procedureVersion: "1.0.0",
    plan: "lifecycle-root",
    mode: "dry-run",
    environment: "local",
    rootInputs: { stable: "stable-repository" },
  };
  await rpc("plan.engage", engagement);
  await declare("first-repository");
  const initial = await read("lifecycle-root");
  const changing = initial.invocations.find((value: any) => value.name === "changing").childPlan;
  const stable = initial.invocations.find((value: any) => value.name === "stable").childPlan;
  assert.notEqual(changing, stable);
  assert.match(await mcpRead("lifecycle-root"), /PROCEDURE INVOCATIONS/);
  const parentAttempt = await admit("lifecycle-root", "independent", "Validate the parent after both children");
  const firstAttempt = await admit(changing, "working tree observation", "Finish changing child");
  const siblingAttempt = await admit(stable, "working tree observation", "Finish stable child");
  const parentPending = await read("lifecycle-root"),
    siblingPending = await read(stable);
  assert.equal(parentPending.nextIntent, "Validate the parent after both children");
  assert.equal(siblingPending.nextIntent, "Finish stable child");
  assert.notEqual((await read(changing)).currentIntent, siblingPending.currentIntent);
  const stale = await rpc("check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey: "stale-sibling-intent",
    checkUri: siblingAttempt.checkUri,
    intent: "Other child intent",
    nextIntent: "wrong",
  });
  assert.equal(stale.status, "REFUSED");
  assert.equal((await finish(siblingAttempt)).verdict, "VALIDATED");
  assert.equal((await read(stable)).currentIntent, "Finish stable child");
  assert.equal((await read("lifecycle-root")).currentIntent, parentPending.currentIntent);
  assert.equal((await read(changing)).nextIntent, "Finish changing child");
  await finish(parentAttempt);
  // An ordinary interruption/retry preserves the same child instance and its current intent.
  await rpc("check.attempt.interrupt", {
    contract: "trust.attempt-interruption-request@1",
    attemptHandle: firstAttempt.attemptHandle,
  });
  const retry = await admit(changing, "working tree observation", "Finish retried child");
  await rpc("plan.engage", engagement);
  assert.equal(
    (await read("lifecycle-root")).invocations.find((value: any) => value.name === "changing").childPlan,
    changing,
  );
  // Hold a real admitted attempt while replacing its parent invocation inputs.
  await declare("replacement-repository");
  const replaced = await read("lifecycle-root");
  const replacement = replaced.invocations.find((value: any) => value.name === "changing").childPlan;
  assert.notEqual(replacement, changing);
  assert.equal(replaced.invocations.find((value: any) => value.name === "stable").childPlan, stable);
  assert.equal((await read(changing)).parent.current, false);
  await mcpRead(replacement);
  const replacementIntent = (await read(replacement)).currentIntent;
  assert.ok(replacementIntent.includes(replacement));
  assert.notEqual(replacementIntent, "Finish retried child");
  assert.equal((await finish(retry)).verdict, "VALIDATED", "already admitted observations remain historical");
  assert.equal((await read(replacement)).currentIntent, replacementIntent);
  assert.equal((await read(replacement)).nextIntent, null);
  const oldAdmission = await rpc("check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey: "old-generation-new-attempt",
    checkUri: (await read(changing)).checks.find((value: any) => value.state === "OPEN").checkUri,
    intent: "Finish retried child",
  });
  assert.equal(oldAdmission.status, "REFUSED");
  for (const method of ["plan.reset", "plan.remove"]) {
    assert.match(JSON.stringify(await rpc(method, { plan: changing }, true)), /composition history/);
    assert.equal((await read(changing)).parent.current, false);
  }
  assert.equal((await read("lifecycle-root")).checks.find((value: any) => value.name === "final").actionable, false);
  await declare("first-repository");
  assert.notEqual(
    (await read("lifecycle-root")).invocations.find((value: any) => value.name === "changing").childPlan,
    changing,
    "restoring old inputs cannot resurrect old child identity",
  );
  const currentChild = (await read("lifecycle-root")).invocations.find(
    (value: any) => value.name === "changing",
  ).childPlan;
  await finish(await admit(currentChild, "working tree observation", "Finish the current child"));
  await finish(await admit(currentChild, "revision observation"));
  await finish(await admit(stable, "revision observation"));
  assert.equal((await read("lifecycle-root")).checks.find((value: any) => value.name === "final").actionable, true);
  const heldFinal = await admit("lifecycle-root", "final");
  // A child requalification after parent admission must be rechecked at finalization.
  assert.equal(
    (await finish(await admit(currentChild, "working tree observation", undefined, { reobserve: true }), "dirty"))
      .verdict,
    "NOT_VALIDATED",
  );
  const staleFinal = await finish(heldFinal, "clean", true);
  assert.match(JSON.stringify(staleFinal), /plan-conflict|invocation/i);
  assert.equal((await read("lifecycle-root")).checks.find((value: any) => value.name === "final").state, "OPEN");
  assert.equal((await read("lifecycle-root")).checks.find((value: any) => value.name === "final").actionable, false);
  await finish(await admit(currentChild, "working tree observation"));
  assert.equal((await finish(await admit("lifecycle-root", "final"))).verdict, "VALIDATED");
});
