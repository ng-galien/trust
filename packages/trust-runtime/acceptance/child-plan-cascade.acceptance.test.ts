import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./support/fixtures.js";
import { type PublicRuntimeProcess, startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
interface View {
  plan: string;
  revision: number;
  workState: string;
  currentIntent: string | null;
  nextIntent: string | null;
  parent: { plan: string; current: boolean; generation: number } | null;
  invocations: { name: string; childPlan: string | null; generation: number; state: string }[];
  checks: { name: string; checkUri: string; state: string; actionable: boolean }[];
}
interface Attempt {
  status: string;
  attemptKey: string;
  attemptHandle: string;
  executionId: string;
  checkUri: string;
  operation: { operation: string };
  environment: Record<string, unknown>;
}

function source(name: string, child?: string, isRoot = false): string {
  return `@trust-dsl:1 @procedure:${name} @version:1.0.0 @intent-chaining
Feature: Observe ${name} through independent child Plans
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe the declared repository in a dry-run. | Execute external actions. |
    And one reference "repository"${isRoot ? ' declared by agent\n    And one reference "stable"' : ""}
${
  child
    ? `  @scenario:children
  Scenario: Complete required children
    Then Invocation "branch" runs Procedure "${child}@1.0.0" on "repository" as Input "repository" and must establish "the branch is complete"
${isRoot ? '    And Invocation "sibling" runs Procedure "cascade-leaf@1.0.0" on "stable" as Input "repository" and must establish "the sibling is complete"\n' : ""}`
    : ""
}  @scenario:final
  Scenario: Validate local completion
${child ? '    Given scenario "children" is validated\n' : ""}    Then Check "final" runs Operation "git.head-read@*" on "${isRoot ? "stable" : "repository"}" as Input "project" and must establish "the working tree is clean"
      """js
      fact.workingTree === "clean" || fail("the working tree is not clean")
      """
`;
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-child-cascade-"));
  const options = {
    storage: { kind: "pglite" as const, directory: path.join(directory, "pglite") },
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root } },
  };
  let runtime: PublicRuntimeProcess = await startPublicRuntime("trust-cascade-process-", options);
  let sequence = 0;
  const rpc = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      signal: AbortSignal.timeout(15_000),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    assert.equal(response.status, 200);
    const envelope = (await response.json()) as { result: T; error?: unknown };
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const read = (plan: string) => rpc<View>("plan.read", { plan });
  const declare = async (repository: string) => {
    const view = await read("cascade-root");
    await rpc("plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: view.plan,
      expectedRevision: view.revision,
      declarations: { repository },
    });
  };
  const admit = async (plan: string, reobserve = false): Promise<Attempt> => {
    const view = await read(plan);
    const admission = await rpc<Attempt>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: view.checks[0]!.checkUri,
      attemptKey: `cascade-attempt-${++sequence}`,
      ...(view.currentIntent ? { intent: view.currentIntent } : {}),
      ...(reobserve ? { reobserve: true } : {}),
    });
    assert.equal(admission.status, "ADMITTED", JSON.stringify(admission));
    assert.deepEqual(admission.environment, {});
    return admission;
  };
  const facts = async (attempt: Attempt, workingTree = "clean") => {
    const observedAt = new Date().toISOString();
    return rpc<{ acceptedFactIds: string[]; duplicateFactIds: string[] }>("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptKey: attempt.attemptKey,
      attemptHandle: attempt.attemptHandle,
      executionId: attempt.executionId,
      checkUri: attempt.checkUri,
      recordedAt: observedAt,
      facts: [
        { kind: attempt.operation.operation, observedAt, values: { headRevision: `cascade-${sequence}`, workingTree } },
      ],
    });
  };
  const finalize = (attempt: Attempt) =>
    rpc<{ verdict: string; checklistDelta: unknown }>("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: attempt.attemptHandle,
    });
  const complete = async (plan: string) => {
    const attempt = await admit(plan);
    await facts(attempt);
    assert.equal((await finalize(attempt)).verdict, "VALIDATED");
  };
  const branch = async (): Promise<string[]> => {
    const plans = ["cascade-root"];
    for (let level = 0; level < 3; level++) {
      const view = await read(plans[level]!);
      const child = view.invocations.find((value) => value.name === "branch")?.childPlan;
      assert.ok(child, `level ${level} has a current child`);
      plans.push(child);
    }
    assert.equal(new Set(plans).size, 4);
    return plans;
  };
  const check = (uri: string) =>
    rpc<{ state: string; attempts: { handle: string; state: string; facts: { id: string }[] }[] }>("check.read", {
      contract: "trust.check-read-request@1",
      checkUri: uri,
    });
  try {
    for (const [name, child, isRoot] of [
      ["cascade-leaf", undefined, false],
      ["cascade-middle", "cascade-leaf", false],
      ["cascade-upper", "cascade-middle", false],
      ["cascade-parent", "cascade-upper", true],
    ] as const)
      await rpc("procedure.publish", { source: source(name, child, isRoot) });
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "cascade-parent",
      procedureVersion: "1.0.0",
      plan: "cascade-root",
      environment: "local",
      mode: "dry-run",
      rootInputs: { stable: "stable-repository" },
    });
    await declare("first-repository");
  } catch (error) {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    rpc,
    read,
    declare,
    admit,
    facts,
    finalize,
    complete,
    branch,
    check,
    restart: async () => {
      await runtime.close();
      runtime = await startPublicRuntime("trust-cascade-resumed-", options);
    },
    close: async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const workingTree of ["clean", "dirty"] as const) {
  test(`four-level ${workingTree} child-local requalification withdraws root admission directly and preserves an unrelated sibling`, {
    timeout: 60_000,
  }, async () => {
    const f = await fixture();
    try {
      const plans = await f.branch();
      const sibling = (await f.read(plans[0]!)).invocations.find((value) => value.name === "sibling")!.childPlan!;
      await f.complete(sibling);
      for (const plan of [...plans].reverse()) await f.complete(plan);
      const before = await Promise.all(plans.map(f.read));
      assert.ok(before.every((view) => view.workState === "COMPLETE"));
      const stableBefore = await f.read(sibling);
      const leaf = await f.admit(plans[3]!, true);
      await f.facts(leaf, workingTree);
      assert.equal((await f.finalize(leaf)).verdict, workingTree === "clean" ? "VALIDATED" : "NOT_VALIDATED");
      // No ancestor read intervenes: direct admission must use the persisted transitive withdrawal.
      const refused = await f.rpc<{ status: string; reasonCode: string; reason: string }>("check.attempt.admit", {
        contract: "trust.check-admission-request@1",
        checkUri: before[0]!.checks[0]!.checkUri,
        attemptKey: "cascade-direct-root-refusal",
      });
      assert.equal(refused.status, "REFUSED");
      assert.equal(refused.reasonCode, "check-not-actionable");
      assert.match(
        refused.reason,
        /dependenc|prerequisite/i,
        "refusal must enforce withdrawn dependencies, not merely a missing intent",
      );
      const directRoot = await f.read(plans[0]!);
      assert.equal(directRoot.workState, "IN_PROGRESS");
      assert.equal(directRoot.checks[0]!.state, "OPEN");
      assert.equal(directRoot.checks[0]!.actionable, false);
      for (let level = 0; level < 3; level++) {
        const view = await f.read(plans[level]!);
        assert.equal(
          view.invocations.find((value) => value.name === "branch")!.childPlan,
          plans[level + 1],
          "local requalification must not replace this child",
        );
        assert.equal(view.checks[0]!.state, "OPEN");
        assert.equal(
          view.checks[0]!.actionable,
          workingTree === "clean" && level === 2,
          "only the immediate parent's final Check can resume after positive leaf requalification",
        );
      }
      assert.deepEqual(
        await f.read(sibling),
        stableBefore,
        "unrelated sibling state and intention must remain unchanged",
      );
      assert.equal(
        (await f.check(before[0]!.checks[0]!.checkUri)).attempts.length,
        1,
        "refusal creates no new root attempt",
      );
    } finally {
      await f.close();
    }
  });
}

test("replacing an ancestor during a held leaf attempt retains late Facts only in the old four-level branch", {
  timeout: 60_000,
}, async () => {
  const f = await fixture();
  try {
    const old = await f.branch();
    const sibling = (await f.read(old[0]!)).invocations.find((value) => value.name === "sibling")!.childPlan!;
    await f.complete(sibling);
    const stableBefore = await f.read(sibling);
    const held = await f.admit(old[3]!);
    // The operator Fact submission is intentionally withheld after real public admission.
    await f.declare("replacement-repository");
    const replacement = await f.branch();
    for (let level = 1; level < 4; level++) assert.notEqual(replacement[level], old[level]);
    const replacementBefore = await Promise.all(replacement.map(f.read));
    assert.equal((await f.read(old[1]!)).parent?.current, false);
    const accepted = await f.facts(held);
    assert.equal(accepted.acceptedFactIds.length, 1);
    assert.equal((await f.finalize(held)).verdict, "VALIDATED", "admitted Facts retain historical qualification");
    for (let level = 0; level < 4; level++) {
      assert.deepEqual(
        await f.read(replacement[level]!),
        replacementBefore[level],
        "late old Facts cannot rotate any replacement intent or change active ancestors",
      );
    }
    assert.equal((await f.read(replacement[0]!)).checks[0]!.actionable, false);
    assert.deepEqual(await f.read(sibling), stableBefore);
    const history = await f.check(held.checkUri);
    assert.equal(
      history.attempts.find((value) => value.handle === held.attemptHandle)?.facts[0]?.id,
      accepted.acceptedFactIds[0],
    );
    const oldLeaf = await f.read(old[3]!);
    const refused = await f.rpc<{ status: string; reason: string }>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: held.checkUri,
      attemptKey: "superseded-deep-reobserve",
      reobserve: true,
      ...(oldLeaf.currentIntent ? { intent: oldLeaf.currentIntent } : {}),
    });
    assert.equal(refused.status, "REFUSED", "grandparent supersession blocks direct leaf admission");
    assert.match(refused.reason, /superseded/i);
    assert.deepEqual(await f.finalize(held), await f.finalize(held), "duplicate historic finalization is idempotent");
    assert.deepEqual(await f.read(replacement[0]!), replacementBefore[0]);
  } finally {
    await f.close();
  }
});

test("a four-level leaf resumes accepted Facts after process restart without a second attempt or observation", {
  timeout: 60_000,
}, async () => {
  const f = await fixture();
  try {
    const plans = await f.branch();
    const held = await f.admit(plans[3]!);
    const accepted = await f.facts(held);
    assert.equal(accepted.acceptedFactIds.length, 1);
    const before = await Promise.all(plans.map(f.read));
    const admittedHistory = await f.check(held.checkUri);
    assert.equal(admittedHistory.attempts[0]?.state, "pending");
    await f.restart();
    assert.deepEqual(
      await Promise.all(plans.map(f.read)),
      before,
      "restart preserves current relations and independent intent reservations",
    );
    assert.deepEqual(
      await f.check(held.checkUri),
      admittedHistory,
      "accepted observation survives before finalization",
    );
    const result = await f.finalize(held);
    assert.equal(result.verdict, "VALIDATED");
    const history = await f.check(held.checkUri);
    assert.equal(history.attempts.length, 1);
    assert.equal(history.attempts[0]?.state, "finalized");
    assert.deepEqual(
      history.attempts[0]?.facts.map((value) => value.id),
      accepted.acceptedFactIds,
    );
    assert.deepEqual(await f.finalize(held), result);
    const parent = await f.read(plans[2]!);
    assert.equal(parent.invocations[0]!.state, "SATISFIED");
    assert.equal(parent.checks[0]!.actionable, true);
    assert.equal(parent.workState, "IN_PROGRESS", "leaf finalization does not execute the intermediate final Check");
    assert.equal((await f.read(plans[0]!)).checks[0]!.actionable, false);
  } finally {
    await f.close();
  }
});
