import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
interface View {
  plan: string;
  currentIntent: string | null;
  workState: string;
  sessionState: string;
  parent: { plan: string; invocationId: string; generation: number; current: boolean } | null;
  invocations: { id: string; state: string; childPlan: string | null; generation: number | null }[];
  checks: { name: string; checkUri: string; actionable: boolean; state: string }[];
}
interface Admission {
  status: string;
  attemptKey: string;
  attemptHandle: string;
  executionId: string;
  checkUri: string;
  operation: { operation: string };
  environment: Record<string, unknown>;
}

function source(name: string, child?: string): string {
  return `@trust-dsl:1 @procedure:${name} @version:1.0.0 @intent-chaining
Feature: Independently execute ${name}
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe the declared repository. | Modify external state. |
    And one reference "repository"
  @scenario:start
  Scenario: Establish the local prerequisite
    Then Check "start" runs Operation "git.head-read@*" on "repository" as Input "project" and must establish "the prerequisite is established"
      """js
      fact.workingTree === "clean" || fail("the repository is not clean")
      """
${
  child
    ? `  @scenario:children
  Scenario: Execute the child
    Given scenario "start" is validated
    Then Invocation "child" runs Procedure "${child}@1.0.0" on "repository" as Input "repository" and must establish "the child is complete"
`
    : ""
}  @scenario:finish
  Scenario: Observe the local completion
    Given scenario "${child ? "children" : "start"}" is validated
    Then Check "finish" runs Operation "git.head-read@*" on "repository" as Input "project" and must establish "the local work is complete"
      """js
      fact.workingTree === "clean" || fail("the repository is not clean")
      """
`;
}

async function rpc<T>(endpoint: string, method: string, params: unknown): Promise<T> {
  const response = await fetch(`${endpoint}/rpc`, {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  const envelope = (await response.json()) as { result: T; error?: unknown };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}
const read = (endpoint: string, plan: string) => rpc<View>(endpoint, "plan.read", { plan });

async function qualify(endpoint: string, view: View, name: string, intent: string, nextIntent?: string): Promise<void> {
  const check = view.checks.find((item) => item.name === name);
  assert.ok(check, `${view.plan}: missing ${name}`);
  assert.equal(check.actionable, true, `${view.plan}: ${name} is not actionable`);
  const admitted = await rpc<Admission>(endpoint, "check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    checkUri: check.checkUri,
    attemptKey: `${view.plan}-${name}`,
    intent,
    ...(nextIntent ? { nextIntent } : {}),
  });
  assert.equal(admitted.status, "ADMITTED");
  assert.deepEqual(admitted.environment, {}, "dry-run children must not receive Environment values");
  const observedAt = new Date().toISOString();
  await rpc(endpoint, "check.attempt.facts", {
    contract: "trust.fact-batch-request@1",
    attemptKey: admitted.attemptKey,
    attemptHandle: admitted.attemptHandle,
    executionId: admitted.executionId,
    checkUri: admitted.checkUri,
    recordedAt: observedAt,
    facts: [
      { kind: admitted.operation.operation, observedAt, values: { headRevision: "abc123", workingTree: "clean" } },
    ],
  });
  const result = await rpc<{ verdict: string }>(endpoint, "check.attempt.finalize", {
    contract: "trust.attempt-finalization-request@1",
    attemptHandle: admitted.attemptHandle,
  });
  assert.equal(result.verdict, "VALIDATED");
}

for (const depth of [3, 4]) {
  test(`${depth} nested Plans preserve independent intentions across restart and require bottom-up final Checks`, {
    timeout: 60_000,
  }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "trust-deep-plan-"));
    const options = {
      databasePath: path.join(directory, "runtime.sqlite"),
      operationsDirectory: path.join(root, "assets/operations"),
      environments: { local: { workspaceRoot: root } },
    };
    let runtime = await startPublicRuntime("trust-deep-process-", options);
    try {
      const names = Array.from({ length: depth }, (_, level) => `depth-${depth}-level-${level}`);
      for (let level = depth - 1; level >= 0; level--) {
        await rpc(runtime.endpoint, "procedure.publish", { source: source(names[level]!, names[level + 1]) });
      }
      await rpc(runtime.endpoint, "plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: names[0],
        procedureVersion: "1.0.0",
        plan: `depth-${depth}-root`,
        environment: "local",
        mode: "dry-run",
        rootInputs: { repository: "example" },
      });
      const plans: string[] = [`depth-${depth}-root`];
      const relations: View["parent"][] = [];
      for (let level = 0; level < depth; level++) {
        let view = await read(runtime.endpoint, plans[level]!);
        assert.notEqual(view.workState, "COMPLETE");
        assert.ok(view.currentIntent?.includes(names[level]!), "initial intention must identify this Procedure");
        assert.ok(view.currentIntent?.includes(plans[level]!), "initial intention must identify this Plan");
        if (level > 0)
          assert.notEqual(
            view.currentIntent,
            `Finish level ${level - 1}.`,
            "child must not inherit the parent's intention",
          );
        assert.ok(
          view.invocations.every((item) => item.childPlan === null),
          "child must wait for local prerequisite",
        );
        relations.push(view.parent);
        await qualify(runtime.endpoint, view, "start", view.currentIntent!, `Finish level ${level}.`);
        view = await read(runtime.endpoint, plans[level]!);
        assert.equal(view.currentIntent, `Finish level ${level}.`);
        if (level < depth - 1) {
          const invocation = view.invocations[0]!;
          assert.ok(invocation.childPlan);
          assert.equal(invocation.state, "RUNNING");
          assert.equal(view.checks.find((item) => item.name === "finish")?.actionable, false);
          plans.push(invocation.childPlan);
          const child = await read(runtime.endpoint, invocation.childPlan);
          assert.equal(child.parent?.plan, plans[level]);
          assert.equal(child.parent?.invocationId, invocation.id);
          assert.equal(child.parent?.generation, invocation.generation);
          assert.equal(child.parent?.current, true);
        }
      }
      assert.equal(new Set(plans).size, depth);
      await runtime.close();
      runtime = await startPublicRuntime("trust-deep-resumed-", options);
      for (let level = 0; level < depth; level++) {
        const view = await read(runtime.endpoint, plans[level]!);
        assert.deepEqual(view.parent, relations[level]);
        assert.equal(view.currentIntent, `Finish level ${level}.`);
        if (level < depth - 1) assert.equal(view.invocations[0]?.childPlan, plans[level + 1]);
      }
      // Closing an ancestor Session is not cancellation of independent children.
      await rpc(runtime.endpoint, "plan.close", { plan: plans[0] });
      for (let level = depth - 1; level >= 1; level--) {
        const view = await read(runtime.endpoint, plans[level]!);
        await qualify(runtime.endpoint, view, "finish", `Finish level ${level}.`);
        assert.equal((await read(runtime.endpoint, plans[level]!)).workState, "COMPLETE");
        const parent = await read(runtime.endpoint, plans[level - 1]!);
        assert.equal(parent.invocations[0]?.state, "SATISFIED");
        assert.notEqual(parent.workState, "COMPLETE", "child completion cannot bypass parent's final Check");
      }
      await rpc(runtime.endpoint, "plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: names[0],
        procedureVersion: "1.0.0",
        plan: plans[0],
        environment: "local",
        mode: "dry-run",
        rootInputs: { repository: "example" },
      });
      await qualify(runtime.endpoint, await read(runtime.endpoint, plans[0]!), "finish", "Finish level 0.");
      assert.equal((await read(runtime.endpoint, plans[0]!)).workState, "COMPLETE");
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
