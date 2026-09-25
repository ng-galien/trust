import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type PublicRuntimeProcess, startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const childSource = `@trust-dsl:1 @procedure:result-child @version:1.0.0
Feature: Observe a repository revision
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe a repository. | Change the repository. |
    And one reference "repository"
    And one reference "revision" returned
  @scenario:observe
  Scenario: Observe the revision
    Then Check "read revision" runs Operation "git.head-read@*" on "repository" as Input "project" and materializes "revision" from field "headRevision" and must establish "the revision is observed"
      """js
      fact.workingTree === "clean" || fail("the working tree is not clean")
      """
`;
const parentSource = `@trust-dsl:1 @procedure:result-parent @version:1.0.0
Feature: Use a child result
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe a repository. | Change the repository. |
    And one reference "repository"
    And one reference "child revision"
  @scenario:child
  Scenario: Delegate revision observation
    Then Invocation "observe child" runs Procedure "result-child@1.0.0" on "repository" as Input "repository" and materializes "child revision" from Result "revision" and must establish "the child observation is complete"
  @scenario:compare
  Scenario: Compare the returned revision
    Given scenario "child" is validated
    Then Check "compare" runs Operation "git.head-compare@*" on "repository" as Input "project" using "child revision" as Input "baseRevision" and must establish "the child revision is used"
      """js
      fact.comparedBaseRevision === context["child revision"] || fail("another revision was compared")
      """
`;

test("child Results enter parent context only after complete validation and are withdrawn on requalification", {
  timeout: 40_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-child-results-db-"));
  const options = {
    storage: { kind: "pglite" as const, directory: path.join(directory, "pglite") },
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root } },
  };
  let runtime: PublicRuntimeProcess = await startPublicRuntime("trust-child-results-", options);
  let sequence = 0;
  const rpc = async (method: string, params: unknown, failure = false): Promise<any> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    const envelope = (await response.json()) as { result?: any; error?: any };
    if (failure) {
      assert.ok(envelope.error, `expected ${method} to fail`);
      return envelope.error;
    }
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const read = (plan: string) => rpc("plan.read", { plan });
  const observe = async (plan: string, revision: string, workingTree = "clean", reobserve = false) => {
    const view = await read(plan);
    const check = view.checks.find((item: any) => item.name === "read revision");
    const attempt = await rpc("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: check.checkUri,
      attemptKey: `result-${++sequence}`,
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
      facts: [{ kind: attempt.operation.operation, observedAt, values: { headRevision: revision, workingTree } }],
    });
    return rpc("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: attempt.attemptHandle,
    });
  };
  try {
    await rpc("procedure.publish", { source: childSource });
    await rpc("procedure.publish", { source: parentSource });
    const invalid = parentSource.replace('from Result "revision"', 'from Result "repository"');
    assert.match(JSON.stringify(await rpc("procedure.compile", { source: invalid }, true)), /returned Result/);
    const wrongType = parentSource.replace('one reference "child revision"', 'one number "child revision"');
    assert.match(JSON.stringify(await rpc("procedure.compile", { source: wrongType }, true)), /incompatible/);
    const repeated = parentSource.replace(
      'and materializes "child revision" from Result "revision" and must establish',
      'and materializes "child revision" from Result "revision" and materializes "child revision" from Result "revision" and must establish',
    );
    assert.match(JSON.stringify(await rpc("procedure.compile", { source: repeated }, true)), /one observed provider/);
    const unobserved = childSource.replace('and materializes "revision" from field "headRevision" ', "");
    assert.match(JSON.stringify(await rpc("procedure.compile", { source: unobserved }, true)), /must be produced/);
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "result-parent",
      procedureVersion: "1.0.0",
      plan: "result-root",
      environment: "local",
      mode: "dry-run",
      rootInputs: { repository: "repo" },
    });
    const initial = await read("result-root");
    assert.deepEqual(initial.importedResults, []);
    assert.equal(initial.checks.length, 0);
    const childPlan = initial.invocations[0].childPlan;
    assert.ok(childPlan);
    assert.equal((await observe(childPlan, "revision-one")).verdict, "VALIDATED");
    const completed = await read("result-root");
    assert.equal(completed.invocations[0].childPlan, childPlan);
    assert.equal(completed.invocations[0].state, "SATISFIED");
    assert.equal(completed.importedResults[0].value, "revision-one");
    assert.equal(completed.importedResults[0].childPlan, childPlan);
    assert.equal(completed.checks[0].inputs.baseRevision, "revision-one");
    await runtime.close();
    runtime = await startPublicRuntime("trust-child-results-restarted-", options);
    const resumed = await read("result-root");
    assert.equal(resumed.importedResults[0].value, "revision-one");
    assert.equal(resumed.checks[0].inputs.baseRevision, "revision-one");
    const compared = await rpc("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: completed.checks[0].checkUri,
      attemptKey: `compare-${++sequence}`,
    });
    assert.equal(compared.status, "ADMITTED");
    const observedAt = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptKey: compared.attemptKey,
      attemptHandle: compared.attemptHandle,
      executionId: compared.executionId,
      checkUri: compared.checkUri,
      recordedAt: observedAt,
      facts: [
        {
          kind: compared.operation.operation,
          observedAt,
          values: {
            headRevision: "revision-one",
            comparedBaseRevision: "revision-one",
            commitsAhead: 0,
            workingTree: "clean",
          },
        },
      ],
    });
    assert.equal(
      (
        await rpc("check.attempt.finalize", {
          contract: "trust.attempt-finalization-request@1",
          attemptHandle: compared.attemptHandle,
        })
      ).verdict,
      "VALIDATED",
    );
    assert.equal((await read("result-root")).checks[0].state, "SATISFIED");
    assert.equal((await observe(childPlan, "revision-two", "clean", true)).verdict, "VALIDATED");
    const updated = await read("result-root");
    assert.equal(updated.invocations[0].childPlan, childPlan);
    assert.equal(updated.importedResults[0].value, "revision-two");
    assert.equal(updated.checks[0].inputs.baseRevision, "revision-two");
    assert.equal(updated.checks[0].state, "OPEN");
    assert.equal((await observe(childPlan, "revision-three", "dirty", true)).verdict, "NOT_VALIDATED");
    const withdrawn = await read("result-root");
    assert.equal(withdrawn.invocations[0].childPlan, childPlan);
    assert.deepEqual(withdrawn.importedResults, []);
    assert.equal(withdrawn.checks.length, 0);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("declared missions validate their Result interface and aggregate completed children", {
  timeout: 40_000,
}, async () => {
  const runtime = await startPublicRuntime("trust-mission-results-", {
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root } },
  });
  let sequence = 0;
  const rpc = async (method: string, params: unknown, failure = false): Promise<any> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    const envelope = (await response.json()) as { result?: any; error?: any };
    if (failure) {
      assert.ok(envelope.error);
      return envelope.error;
    }
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const read = () => rpc("plan.read", { plan: "mission-results-root" });
  const mission = (id: string, procedure: string) => ({
    id,
    definition: { kind: "published", reference: `${procedure}@1.0.0` },
    rootInputs: { repository: id },
  });
  const declare = async (missions: unknown[], failure = false) => {
    const view = await read();
    return rpc(
      "plan.declarations.replace",
      {
        contract: "trust.plan-declaration-replacement-request@1",
        plan: "mission-results-root",
        expectedRevision: view.revision,
        declarations: {},
        missionDeclarations: { work: missions },
      },
      failure,
    );
  };
  const complete = async (plan: string, revision: string, reobserve = false) => {
    const child = await rpc("plan.read", { plan });
    const attempt = await rpc("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: child.checks[0].checkUri,
      attemptKey: `mission-result-${++sequence}`,
      ...(reobserve ? { reobserve: true } : {}),
    });
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
          values: {
            headRevision: revision,
            workingTree: "clean",
          },
        },
      ],
    });
    assert.equal(
      (
        await rpc("check.attempt.finalize", {
          contract: "trust.attempt-finalization-request@1",
          attemptHandle: attempt.attemptHandle,
        })
      ).verdict,
      "VALIDATED",
    );
  };
  try {
    await rpc("procedure.publish", { source: childSource });
    await rpc("procedure.publish", {
      source: childSource
        .replaceAll("result-child", "no-result-child")
        .replace('And one reference "revision" returned', 'And one reference "revision"'),
    });
    await rpc("procedure.publish", {
      source: `@trust-dsl:1 @procedure:mission-result-parent @version:1.0.0
Feature: Aggregate mission Results
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repositories. | Change repositories. |
    And missions "work" declared by agent
    And many reference "revisions"
  @scenario:work
  Scenario: Complete the missions
    Then Invocation "observe work" runs each declared Procedure in "work" and materializes "revisions" from Result "revision" and must establish "all missions are complete"
`,
    });
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "mission-result-parent",
      procedureVersion: "1.0.0",
      plan: "mission-results-root",
      environment: "local",
      mode: "dry-run",
      rootInputs: {},
    });
    assert.match(JSON.stringify(await declare([mission("bad", "no-result-child")], true)), /Result.*incompatible/);
    assert.equal((await read()).invocations.length, 0, "rejected mission creates no child");
    await declare([mission("first", "result-child")]);
    const first = (await read()).invocations[0].childPlan;
    assert.ok(first);
    await complete(first, "first-revision");
    assert.deepEqual(
      (await read()).importedResults.map((item: any) => item.value),
      ["first-revision"],
    );
    await declare([mission("first", "result-child"), mission("second", "result-child")]);
    const afterAppend = await read();
    assert.equal(afterAppend.invocations[0].childPlan, first);
    assert.deepEqual(
      afterAppend.importedResults.map((item: any) => item.value),
      ["first-revision"],
    );
    const second = afterAppend.invocations[1].childPlan;
    assert.ok(second);
    await complete(second, "second-revision");
    assert.deepEqual(
      new Set((await read()).importedResults.map((item: any) => item.value)),
      new Set(["first-revision", "second-revision"]),
    );
    await complete(second, "first-revision", true);
    const repeatedValue = await read();
    assert.equal(repeatedValue.importedResults.length, 2, "both child generations retain provenance");
    assert.deepEqual(
      repeatedValue.importedResults.map((item: any) => item.value),
      ["first-revision", "first-revision"],
    );
  } finally {
    await runtime.close();
  }
});

test("on each child Result retains its parent target coordinate", { timeout: 40_000 }, async () => {
  const runtime = await startPublicRuntime("trust-correlated-child-results-", {
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root } },
  });
  let sequence = 0;
  const rpc = async (method: string, params: unknown): Promise<any> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    const envelope = (await response.json()) as { result?: any; error?: any };
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  try {
    await rpc("procedure.publish", { source: childSource });
    await rpc("procedure.publish", {
      source: `@trust-dsl:1 @procedure:correlated-result-parent @version:1.0.0
Feature: Correlate returned revisions
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repositories. | Change repositories. |
    And many reference "repositories"
    And many reference "revisions" for each "repositories"
  @scenario:children
  Scenario: Observe every repository
    Then Invocation "observe each" runs Procedure "result-child@1.0.0" on each "repositories" as Input "repository" and materializes "revisions" from Result "revision" and must establish "all revisions are observed"
  @scenario:compare
  Scenario: Compare correlated revisions
    Given scenario "children" is validated
    Then Check "compare each" runs Operation "git.head-compare@*" on each "repositories" as Input "project" using "revisions" as Input "baseRevision" and must establish "each revision is correlated"
      """js
      fact.comparedBaseRevision === context["revisions"] || fail("another revision was compared")
      """
`,
    });
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "correlated-result-parent",
      procedureVersion: "1.0.0",
      plan: "correlated-result-root",
      environment: "local",
      mode: "dry-run",
      rootInputs: { repositories: ["repo-a", "repo-b"] },
    });
    const initial = await rpc("plan.read", { plan: "correlated-result-root" });
    assert.equal(initial.invocations.length, 2);
    for (const invocation of initial.invocations) {
      const child = await rpc("plan.read", { plan: invocation.childPlan });
      const repository = child.rootInputs.repository;
      const attempt = await rpc("check.attempt.admit", {
        contract: "trust.check-admission-request@1",
        checkUri: child.checks[0].checkUri,
        attemptKey: `correlated-${++sequence}`,
      });
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
            values: {
              headRevision: `${repository}-revision`,
              workingTree: "clean",
            },
          },
        ],
      });
      assert.equal(
        (
          await rpc("check.attempt.finalize", {
            contract: "trust.attempt-finalization-request@1",
            attemptHandle: attempt.attemptHandle,
          })
        ).verdict,
        "VALIDATED",
      );
    }
    const parent = await rpc("plan.read", { plan: "correlated-result-root" });
    assert.deepEqual(
      new Map(parent.importedResults.map((item: any) => [item.parents.repositories, item.value])),
      new Map([
        ["repo-a", "repo-a-revision"],
        ["repo-b", "repo-b-revision"],
      ]),
    );
    assert.deepEqual(
      new Map(parent.checks.map((check: any) => [check.inputs.project, check.inputs.baseRevision])),
      new Map([
        ["repo-a", "repo-a-revision"],
        ["repo-b", "repo-b-revision"],
      ]),
    );
  } finally {
    await runtime.close();
  }
});

test("a child Result can feed a parent Check and a subsequent child Result", { timeout: 40_000 }, async () => {
  const runtime = await startPublicRuntime("trust-chained-child-results-", {
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root } },
  });
  let sequence = 0;
  const rpc = async (method: string, params: unknown): Promise<any> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    const envelope = (await response.json()) as { result?: any; error?: any };
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const read = (plan: string) => rpc("plan.read", { plan });
  const finalize = async (check: any, values: Record<string, unknown>) => {
    const attempt = await rpc("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: check.checkUri,
      attemptKey: `chain-${++sequence}`,
    });
    assert.equal(attempt.status, "ADMITTED");
    const observedAt = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptKey: attempt.attemptKey,
      attemptHandle: attempt.attemptHandle,
      executionId: attempt.executionId,
      checkUri: attempt.checkUri,
      recordedAt: observedAt,
      facts: [{ kind: attempt.operation.operation, observedAt, values }],
    });
    assert.equal(
      (
        await rpc("check.attempt.finalize", {
          contract: "trust.attempt-finalization-request@1",
          attemptHandle: attempt.attemptHandle,
        })
      ).verdict,
      "VALIDATED",
    );
  };
  try {
    await rpc("procedure.publish", { source: childSource });
    await rpc("procedure.publish", {
      source: `@trust-dsl:1 @procedure:chained-result-parent @version:1.0.0
Feature: Chain returned and observed revisions
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repositories. | Change repositories. |
    And many reference "repositories"
    And many reference "z first revision" for each "repositories"
    And many reference "middle revision" for each "z first revision"
    And many reference "a final revision" for each "middle revision"
  @scenario:first
  Scenario: Delegate the first observation
    Then Invocation "observe first" runs Procedure "result-child@1.0.0" on each "repositories" as Input "repository" and materializes "z first revision" from Result "revision" and must establish "the first observation is complete"
  @scenario:middle
  Scenario: Observe the middle revision
    Given scenario "first" is validated
    Then Check "observe middle" runs Operation "git.head-compare@*" on each "z first revision" as Input "project" using "z first revision" as Input "baseRevision" and materializes "middle revision" from field "headRevision" and must establish "the middle revision is observed"
      """js
      fact.workingTree === "clean" || fail("the working tree is not clean")
      """
  @scenario:final
  Scenario: Delegate the final observation
    Given scenario "middle" is validated
    Then Invocation "observe final" runs Procedure "result-child@1.0.0" on each "middle revision" as Input "repository" and materializes "a final revision" from Result "revision" and must establish "the final observation is complete"
`,
    });
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "chained-result-parent",
      procedureVersion: "1.0.0",
      plan: "chained-result-root",
      environment: "local",
      mode: "dry-run",
      rootInputs: { repositories: ["repo"] },
    });
    const first = await read("chained-result-root");
    assert.equal(first.invocations.length, 1);
    await finalize((await read(first.invocations[0].childPlan)).checks[0], {
      headRevision: "first",
      workingTree: "clean",
    });
    const middle = await read("chained-result-root");
    assert.equal(middle.checks.length, 1);
    await finalize(middle.checks[0], {
      headRevision: "middle",
      comparedBaseRevision: "first",
      commitsAhead: 0,
      workingTree: "clean",
    });
    const beforeFinal = await read("chained-result-root");
    assert.equal(beforeFinal.invocations.length, 2);
    const lastChild = beforeFinal.invocations.find((item: any) => item.name === "observe final")?.childPlan;
    assert.ok(lastChild);
    assert.equal((await read(lastChild)).rootInputs.repository, "middle");
    await finalize((await read(lastChild)).checks[0], {
      headRevision: "final",
      workingTree: "clean",
    });
    const complete = await read("chained-result-root");
    assert.deepEqual(
      new Map(complete.importedResults.map((item: any) => [item.role, item.value])),
      new Map([
        ["z first revision", "first"],
        ["a final revision", "final"],
      ]),
    );
    assert.deepEqual(complete.importedResults.find((item: any) => item.role === "a final revision")?.parents, {
      "middle revision": "middle",
    });
    assert.equal(complete.invocations.find((item: any) => item.name === "observe final")?.state, "SATISFIED");
  } finally {
    await runtime.close();
  }
});

test("replacing a child generation withdraws its Result until the replacement completes", {
  timeout: 40_000,
}, async () => {
  const runtime = await startPublicRuntime("trust-replaced-child-result-", {
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root } },
  });
  let sequence = 0;
  const rpc = async (method: string, params: unknown): Promise<any> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    const envelope = (await response.json()) as { result?: any; error?: any };
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const read = () => rpc("plan.read", { plan: "replacement-root" });
  const declare = async (repository: string) => {
    const view = await read();
    await rpc("plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "replacement-root",
      expectedRevision: view.revision,
      declarations: { repository },
    });
  };
  const complete = async (childPlan: string, revision: string) => {
    const child = await rpc("plan.read", { plan: childPlan });
    const attempt = await rpc("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: child.checks[0].checkUri,
      attemptKey: `replacement-${++sequence}`,
    });
    assert.equal(attempt.status, "ADMITTED");
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
          values: {
            headRevision: revision,
            workingTree: "clean",
          },
        },
      ],
    });
    assert.equal(
      (
        await rpc("check.attempt.finalize", {
          contract: "trust.attempt-finalization-request@1",
          attemptHandle: attempt.attemptHandle,
        })
      ).verdict,
      "VALIDATED",
    );
  };
  try {
    await rpc("procedure.publish", { source: childSource });
    await rpc("procedure.publish", {
      source: parentSource
        .replace('And one reference "repository"', 'And one reference "repository" declared by agent')
        .replace("@procedure:result-parent", "@procedure:replacement-result-parent"),
    });
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "replacement-result-parent",
      procedureVersion: "1.0.0",
      plan: "replacement-root",
      environment: "local",
      mode: "dry-run",
      rootInputs: {},
    });
    await declare("repo-one");
    const original = (await read()).invocations[0].childPlan;
    assert.ok(original);
    await complete(original, "old-revision");
    assert.equal((await read()).importedResults[0].value, "old-revision");
    await declare("repo-two");
    const replaced = await read();
    const next = replaced.invocations[0].childPlan;
    assert.ok(next);
    assert.notEqual(next, original);
    assert.deepEqual(replaced.importedResults, []);
    assert.equal(replaced.checks.length, 0);
    assert.equal((await rpc("plan.read", { plan: original })).parent.current, false);
    await complete(next, "new-revision");
    const current = await read();
    assert.equal(current.importedResults[0].value, "new-revision");
    assert.equal(current.importedResults[0].childPlan, next);
    assert.equal(current.checks[0].inputs.baseRevision, "new-revision");
  } finally {
    await runtime.close();
  }
});
