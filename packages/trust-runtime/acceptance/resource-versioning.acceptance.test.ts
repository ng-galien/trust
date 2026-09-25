import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CompiledProcedure } from "@trust/procedure";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
async function request(endpoint: string, method: string, params: unknown) {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { result?: any; error?: { message: string; data?: { reason?: string } } };
}
async function rpc(endpoint: string, method: string, params: unknown): Promise<any> {
  const response = await request(endpoint, method, params);
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
}
function procedure(name: string, selector = "^1.0.0", child?: string, version = "1.0.0") {
  return `@trust-dsl:1 @procedure:${name} @version:${version}
Feature: Resolve ${name}
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the repository. | Modify it. |
    And one reference "repository"
  @scenario:gate
  Scenario: Observe
    Then Check "gate" runs Operation "version.observe@${selector}" on "repository" as Input "project" and must establish "the repository is clean"
      """js
      fact.workingTree === "clean" || fail("the repository is dirty")
      """
${
  child
    ? `  @scenario:child
  Scenario: Child
    Given scenario "gate" is validated
    Then Invocation "child" runs Procedure "${child}" on "repository" as Input "repository" and must establish "the child completes"
`
    : ""
}`;
}
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-versioning-"));
  const operationsDirectory = path.join(directory, "operations");
  await mkdir(operationsDirectory);
  const options = {
    storage: { kind: "pglite" as const, directory: path.join(directory, "pglite") },
    operationsDirectory,
    environments: { local: { workspaceRoot: root } },
  };
  let runtime = await startPublicRuntime("trust-versioning-process-", options);
  const template = (await readFile(path.join(root, "assets/operations/git.head-read.feature"), "utf8")).replace(
    "@operation:git.head-read",
    "@operation:version.observe",
  );
  return {
    get endpoint() {
      return runtime.endpoint;
    },
    async operation(version: string, incompatible = false) {
      const source = template.replace("@version:1.0.0", `@version:${version}`);
      return rpc(runtime.endpoint, "operation.save", {
        source: incompatible ? source.replaceAll("project", "workspace") : source,
        sourceName: `version.observe@${version}.feature`,
      });
    },
    async publish(source: string) {
      return rpc(runtime.endpoint, "procedure.publish", { source });
    },
    async engage(name: string, plan: string) {
      return rpc(runtime.endpoint, "plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: name,
        procedureVersion: "1.0.0",
        plan,
        environment: "local",
        mode: "dry-run",
        rootInputs: { repository: "example" },
      });
    },
    async restart() {
      await runtime.close();
      runtime = await startPublicRuntime("trust-versioning-process-", options);
    },
    async close() {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function gate(
  endpoint: string,
  plan: string,
  expectedVersion: string | ((version: string) => void),
  options: { dirty?: boolean; reobserve?: boolean } = {},
) {
  const view = await rpc(endpoint, "plan.read", { plan });
  const admitted = await rpc(endpoint, "check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    checkUri: view.checks[0].checkUri,
    attemptKey: randomUUID(),
    ...(options.reobserve ? { reobserve: true } : {}),
  });
  assert.equal(admitted.status, "ADMITTED");
  if (typeof expectedVersion === "function") expectedVersion(admitted.operation.version);
  else assert.equal(admitted.operation.version, expectedVersion);
  const observedAt = new Date().toISOString();
  await rpc(endpoint, "check.attempt.facts", {
    contract: "trust.fact-batch-request@1",
    attemptHandle: admitted.attemptHandle,
    attemptKey: admitted.attemptKey,
    executionId: admitted.executionId,
    checkUri: admitted.checkUri,
    recordedAt: observedAt,
    facts: [
      {
        kind: admitted.operation.operation,
        observedAt,
        values: { headRevision: "abc", workingTree: options.dirty ? "dirty" : "clean" },
      },
    ],
  });
  const finalized = await rpc(endpoint, "check.attempt.finalize", {
    contract: "trust.attempt-finalization-request@1",
    attemptHandle: admitted.attemptHandle,
  });
  assert.equal(finalized.verdict, options.dirty ? "NOT_VALIDATED" : "VALIDATED");
  return rpc(endpoint, "plan.read", { plan });
}

test("catalog presentation can change without republishing or changing an engaged Plan", async () => {
  const fixture = await setup();
  try {
    await fixture.operation("1.0.0");
    await fixture.publish(procedure("catalog-presentation"));
    await fixture.engage("catalog-presentation", "catalog-presentation-plan");

    const before = await rpc(fixture.endpoint, "plan.read", { plan: "catalog-presentation-plan" });
    const originalOperation = await rpc(fixture.endpoint, "operation.read", {
      operation: "version.observe",
      version: "1.0.0",
    });
    const originalProcedure = await rpc(fixture.endpoint, "procedure.read", {
      procedure: "catalog-presentation",
      version: "1.0.0",
    });

    const operationMetadata = await rpc(fixture.endpoint, "catalog.metadata.update", {
      kind: "operation",
      name: "version.observe",
      version: "1.0.0",
      expectedRevision: 0,
      title: "Inspect repository state",
      description: "Read the current repository status for a review.",
      classification: { domain: ["repository"], nature: ["inspection"] },
    });
    assert.equal(operationMetadata.revision, 1);
    const procedureMetadata = await rpc(fixture.endpoint, "catalog.metadata.update", {
      kind: "procedure",
      name: "catalog-presentation",
      version: "1.0.0",
      expectedRevision: 0,
      title: "Review a repository",
      description: "Confirm a clean repository before follow-up work.",
      classification: { purpose: ["review"] },
    });
    assert.equal(procedureMetadata.revision, 1);

    const foundOperations = await rpc(fixture.endpoint, "operation.list", { query: "repository inspection" });
    assert.equal(foundOperations.operations.length, 1);
    assert.equal(foundOperations.metadata[0].title, "Inspect repository state");
    const foundProcedures = await rpc(fixture.endpoint, "procedure.list", { query: "follow-up review" });
    assert.equal(foundProcedures.procedures.length, 1);
    assert.equal(foundProcedures.metadata[0].title, "Review a repository");
    const operationSummary = await rpc(fixture.endpoint, "operation.list", { summary: true, query: "inspection" });
    assert.equal(operationSummary.operations[0].title, "Inspect repository state");
    const procedureSummary = await rpc(fixture.endpoint, "procedure.list", { summary: true, query: "review" });
    assert.equal(procedureSummary.procedures[0].procedure.title, "Review a repository");

    assert.deepEqual(
      await rpc(fixture.endpoint, "operation.read", {
        operation: "version.observe",
        version: "1.0.0",
      }),
      originalOperation,
    );
    assert.deepEqual(
      await rpc(fixture.endpoint, "procedure.read", {
        procedure: "catalog-presentation",
        version: "1.0.0",
      }),
      originalProcedure,
    );
    assert.deepEqual(await rpc(fixture.endpoint, "plan.read", { plan: "catalog-presentation-plan" }), before);

    const conflict = await request(fixture.endpoint, "catalog.metadata.update", {
      kind: "operation",
      name: "version.observe",
      version: "1.0.0",
      expectedRevision: 0,
      title: "Stale title",
      classification: {},
    });
    assert.match(conflict.error?.message ?? "", /revision is 1/);

    await fixture.restart();
    const afterRestart = await rpc(fixture.endpoint, "catalog.metadata.read", {
      kind: "procedure",
      name: "catalog-presentation",
      version: "1.0.0",
    });
    assert.deepEqual(afterRestart, procedureMetadata);
    const cleared = await rpc(fixture.endpoint, "catalog.metadata.update", {
      kind: "procedure",
      name: "catalog-presentation",
      version: "1.0.0",
      expectedRevision: 1,
      title: "Review a repository",
      classification: {},
    });
    assert.equal(cleared.revision, 2);
    assert.deepEqual(cleared.classification, {});
    assert.equal(cleared.description, undefined);
    const history = await rpc(fixture.endpoint, "catalog.metadata.history", {
      kind: "procedure",
      name: "catalog-presentation",
      version: "1.0.0",
    });
    assert.deepEqual(
      history.history.map((entry: { revision: number }) => entry.revision),
      [0, 1, 2],
    );
    assert.equal(history.history[0].title, originalProcedure.procedure.title);
  } finally {
    await fixture.close();
  }
});

test("public compiler resolves standard SemVer selectors and refuses malformed, missing and incompatible references", {
  timeout: 60_000,
}, async () => {
  const fixture = await setup();
  try {
    for (const version of ["0.2.1", "0.2.9", "0.3.0", "1.0.0", "1.2.0", "1.10.0", "2.0.0-beta.1", "2.0.0-beta.2"])
      await fixture.operation(version);
    for (const [selector, expected] of [
      ["1.2.0", "1.2.0"],
      ["^1.0.0", "1.10.0"],
      ["~1.2.0", "1.2.0"],
      ["^0.2.1", "0.2.9"],
      ["*", "1.10.0"],
      [">=2.0.0-beta.1 <2.0.0", "2.0.0-beta.2"],
      ["1.0.0 - 1.2.0", "1.2.0"],
      ["0.3.x || ~1.2.0", "1.2.0"],
    ]) {
      const compiled: CompiledProcedure = await rpc(fixture.endpoint, "procedure.compile", {
        source: procedure("selection", selector),
      });
      assert.equal(compiled.checks[0]!.operationVersion, expected);
      assert.equal(compiled.checks[0]!.operationSelector, selector);
    }
    for (const selector of ["latest", "^99.0.0", "", "not-semver"])
      assert.ok(
        (await request(fixture.endpoint, "procedure.compile", { source: procedure("selection", selector) })).error,
        selector,
      );
    assert.ok(
      (
        await request(fixture.endpoint, "procedure.compile", {
          source: procedure("selection").replace("version.observe@^1.0.0", "version.observe"),
        })
      ).error,
    );
    await fixture.operation("1.11.0", true);
    const rejected = await request(fixture.endpoint, "procedure.compile", { source: procedure("selection") });
    assert.equal(
      rejected.error?.data?.reason,
      "unknown-input",
      "highest match must fail binding, not fall back to compatible 1.10.0",
    );
    const exact: CompiledProcedure = await rpc(fixture.endpoint, "procedure.compile", {
      source: procedure("selection", "1.10.0"),
    });
    assert.equal(exact.checks[0]!.operationVersion, "1.10.0");
  } finally {
    await fixture.close();
  }
});

for (const depth of [3, 4])
  test(`${depth}-level floating composition resolves at engagement and stays pinned through delayed child creation and restart`, {
    timeout: 60_000,
  }, async () => {
    const fixture = await setup();
    try {
      await fixture.operation("1.0.0");
      const names = Array.from({ length: depth }, (_, index) => `version-depth-${depth}-${index}`);
      for (let index = depth - 1; index >= 0; index--)
        await fixture.publish(
          procedure(names[index]!, "^1.0.0", names[index + 1] ? `${names[index + 1]}@^1.0.0` : undefined),
        );
      const original = await fixture.publish(procedure(names[0]!, "^1.0.0", `${names[1]}@^1.0.0`));
      await fixture.operation("1.10.0");
      await fixture.publish(procedure(names[depth - 1]!, "^1.0.0", undefined, "1.1.0"));
      await fixture.engage(names[0]!, `pinned-${depth}`);
      await fixture.operation("1.20.0");
      await fixture.publish(procedure(names[depth - 1]!, "^1.0.0", undefined, "1.2.0"));
      assert.deepEqual(
        await fixture.publish(procedure(names[0]!, "^1.0.0", `${names[1]}@^1.0.0`)),
        original,
        "republish keeps original definition",
      );
      await fixture.restart();
      await fixture.engage(names[0]!, `pinned-${depth}`);
      let current = `pinned-${depth}`;
      for (let index = 0; index < depth; index++) {
        const before = await rpc(fixture.endpoint, "plan.read", { plan: current });
        assert.equal(before.procedureVersion, index === depth - 1 ? "1.1.0" : "1.0.0");
        const after = await gate(fixture.endpoint, current, "1.10.0");
        if (index + 1 < depth) {
          assert.ok(after.invocations[0].childPlan);
          current = after.invocations[0].childPlan;
        }
      }
      await fixture.engage(names[0]!, `fresh-${depth}`);
      current = `fresh-${depth}`;
      for (let index = 0; index < depth; index++) {
        const before = await rpc(fixture.endpoint, "plan.read", { plan: current });
        assert.equal(before.procedureVersion, index === depth - 1 ? "1.2.0" : "1.0.0");
        const after = await gate(fixture.endpoint, current, "1.20.0");
        if (index + 1 < depth) current = after.invocations[0].childPlan;
      }
    } finally {
      await fixture.close();
    }
  });

test("engagement refuses a new incompatible child or newly resolved cycle without altering an existing Plan", {
  timeout: 60_000,
}, async () => {
  const fixture = await setup();
  try {
    await fixture.operation("1.0.0");
    await fixture.publish(procedure("version-leaf"));
    await fixture.publish(procedure("version-root", "^1.0.0", "version-leaf@^1.0.0"));
    await fixture.engage("version-root", "old-root");
    await fixture.publish(procedure("version-leaf", "^1.0.0", "version-root@1.0.0", "1.1.0"));
    const cycle = await request(fixture.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "version-root",
      procedureVersion: "1.0.0",
      plan: "cycle-root",
      environment: "local",
      mode: "dry-run",
      rootInputs: { repository: "example" },
    });
    assert.ok(cycle.error, "fresh recursive selection must detect root -> leaf 1.1 -> root");
    assert.equal(cycle.error.data?.reason, "invalid-plan-engagement");
    assert.match(JSON.stringify(cycle.error), /cycle/);
    await fixture.engage("version-root", "old-root");
    const after = await gate(fixture.endpoint, "old-root", "1.0.0");
    assert.equal(
      (await rpc(fixture.endpoint, "plan.read", { plan: after.invocations[0].childPlan })).procedureVersion,
      "1.0.0",
    );
    await fixture.publish(
      procedure("version-leaf", "^1.0.0", undefined, "1.2.0").replaceAll('"repository"', '"other"'),
    );
    const incompatible = await request(fixture.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "version-root",
      procedureVersion: "1.0.0",
      plan: "incompatible-root",
      environment: "local",
      mode: "dry-run",
      rootInputs: { repository: "example" },
    });
    assert.ok(incompatible.error, "binding to highest child must fail instead of falling back");
    assert.equal(incompatible.error.data?.reason, "invalid-plan-engagement");
    assert.match(JSON.stringify(incompatible.error), /Input/);
    assert.ok(
      (await request(fixture.endpoint, "plan.read", { plan: "incompatible-root" })).error,
      "refused engagement cannot partially create a root",
    );
  } finally {
    await fixture.close();
  }
});

test("one Plan can pin two versions of an Operation and dry-run reset preserves both pins", {
  timeout: 60_000,
}, async () => {
  const fixture = await setup();
  try {
    await fixture.operation("1.0.0");
    await fixture.operation("1.1.0");
    const first = procedure("two-versions", "1.0.0");
    const second = first
      .slice(first.indexOf("  @scenario:gate"))
      .replaceAll('"gate"', '"second"')
      .replace("@scenario:gate", "@scenario:second")
      .replace("@1.0.0", "@^1.1.0");
    await fixture.publish(first + second);
    await fixture.engage("two-versions", "two-versions-plan");
    await fixture.operation("1.2.0");
    await rpc(fixture.endpoint, "plan.reset", { plan: "two-versions-plan" });
    const view = await rpc(fixture.endpoint, "plan.read", { plan: "two-versions-plan" });
    assert.equal(view.checks.length, 2);
    for (const [index, expected] of ["1.0.0", "1.1.0"].entries()) {
      const admitted = await rpc(fixture.endpoint, "check.attempt.admit", {
        contract: "trust.check-admission-request@1",
        checkUri: view.checks[index].checkUri,
        attemptKey: `two-versions-${index}`,
      });
      assert.equal(admitted.status, "ADMITTED");
      assert.equal(admitted.operation.version, expected);
    }
  } finally {
    await fixture.close();
  }
});

test("four-level escalation/resume and replacement generations retain the root engagement selection", {
  timeout: 60_000,
}, async () => {
  const fixture = await setup();
  try {
    await fixture.operation("1.0.0");
    const names = ["pinned-root", "pinned-heist", "pinned-vault", "pinned-lock"];
    for (let index = 3; index >= 0; index--)
      await fixture.publish(
        procedure(names[index]!, "^1.0.0", names[index + 1] ? `${names[index + 1]}@^1.0.0` : undefined),
      );
    await fixture.engage(names[0]!, "resume-root");
    let current = "resume-root";
    const oldChildren: string[] = [];
    for (let index = 0; index < 3; index++) {
      current = (await gate(fixture.endpoint, current, "1.0.0")).invocations[0].childPlan;
      oldChildren.push(current);
    }
    const negative = await gate(fixture.endpoint, current, "1.0.0", { dirty: true });
    const check = negative.checks[0];
    await rpc(fixture.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: check.checkUri,
      attemptHandle: check.attemptHandle,
      blockingReason: "The pinned lock observation needs operator review.",
      forbiddenFurtherAction: "Do not change repository state.",
    });
    const escalation = (await rpc(fixture.endpoint, "plan.read", { plan: current })).activeEscalation;
    await fixture.operation("1.1.0");
    await fixture.publish(procedure("pinned-lock", "^1.0.0", undefined, "1.1.0"));
    await rpc(fixture.endpoint, "plan.resume", {
      plan: current,
      escalationId: escalation.escalationId,
      resumeReason: "Continue the same pinned observation.",
    });
    await gate(fixture.endpoint, current, "1.0.0");
    await gate(fixture.endpoint, "resume-root", "1.0.0", { dirty: true, reobserve: true });
    const replaced = await gate(fixture.endpoint, "resume-root", "1.0.0");
    current = replaced.invocations[0].childPlan;
    assert.notEqual(current, oldChildren[0]);
    assert.equal(replaced.invocations[0].generation, 2);
    for (let index = 1; index < 4; index++) {
      const view = await rpc(fixture.endpoint, "plan.read", { plan: current });
      assert.equal(view.procedureVersion, "1.0.0");
      const after = await gate(fixture.endpoint, current, "1.0.0");
      if (index < 3) current = after.invocations[0].childPlan;
    }
  } finally {
    await fixture.close();
  }
});

test("concurrent publication and root engagements pin coherent four-level compositions including shared descendants", {
  timeout: 60_000,
}, async () => {
  const fixture = await setup();
  try {
    await fixture.operation("1.0.0");
    const names = ["race-root", "race-heist", "race-vault", "race-lock"];
    for (let index = 3; index >= 0; index--) {
      let source = procedure(names[index]!, "^1.0.0", names[index + 1] ? `${names[index + 1]}@^1.0.0` : undefined);
      if (index === 2)
        source += `    And Invocation "sibling" runs Procedure "race-lock@^1.0.0" on "repository" as Input "repository" and must establish "the sibling completes"\n`;
      await fixture.publish(source);
    }
    await fixture.engage(names[0]!, "race-before");
    const racing = Array.from({ length: 6 }, (_, index) => `race-concurrent-${index}`);
    await Promise.all([fixture.operation("1.1.0"), ...racing.map((plan) => fixture.engage(names[0]!, plan))]);
    await fixture.engage(names[0]!, "race-after");
    for (const plan of ["race-before", ...racing, "race-after"]) {
      let selected = "";
      let after = await gate(fixture.endpoint, plan, (version) => {
        selected = version;
      });
      assert.ok(["1.0.0", "1.1.0"].includes(selected));
      if (plan === "race-before") assert.equal(selected, "1.0.0");
      if (plan === "race-after") assert.equal(selected, "1.1.0");
      for (let level = 1; level < 3; level++)
        after = await gate(fixture.endpoint, after.invocations[0].childPlan, selected);
      assert.equal(after.invocations.length, 2);
      assert.notEqual(after.invocations[0].childPlan, after.invocations[1].childPlan);
      for (const invocation of after.invocations) await gate(fixture.endpoint, invocation.childPlan, selected);
    }
  } finally {
    await fixture.close();
  }
});
