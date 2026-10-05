import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./support/fixtures.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
function wrapper(name: string, child: string, isRoot = false) {
  return `@trust-dsl:1 @procedure:${name} @version:1.0.0 @intent-chaining
Feature: Surface descendant escalation in ${name}
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe the declared repository. | Modify external state. |
    And one reference "repository"
${isRoot ? '    And one reference "selected" declared by agent\n' : ""}  @scenario:children
  Scenario: Execute children
    Then Invocation "nested" runs Procedure "${child}@1.0.0" on "repository" as Input "repository" and must establish "nested execution complete"
${
  isRoot
    ? `    And Invocation "sibling" runs Procedure "intent-chaining@1.0.0" on "selected" as Input "repository" and must establish "sibling complete"
  @scenario:control
  Scenario: Independent parent control
    Then Check "control" runs Operation "git.head-read@*" on "repository" as Input "project" and must establish "control complete"
      """js
      fact.workingTree === "clean" || fail("control not clean")
      """
  @scenario:finish
  Scenario: Validate parent completion
    Given scenario "children" is validated
    And scenario "control" is validated
    Then Check "finish" runs Operation "git.head-read@*" on "repository" as Input "project" and must establish "parent complete"
      """js
      fact.workingTree === "clean" || fail("not clean")
      """
`
    : ""
}`;
}

test("four-level descendant escalation is navigable, notified, isolated and removed on resume or supersession", {
  timeout: 35_000,
}, async ({ startRuntime }) => {
  const runtime = await startRuntime("trust-child-escalation-", {
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot: root } },
  });
  const controller = new AbortController();
  const rpc = async (method: string, params: unknown): Promise<any> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      signal: AbortSignal.timeout(10_000),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const envelope = (await response.json()) as any;
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const read = (plan: string) => rpc("plan.read", { plan });
  const mcp = async (plan: string) => {
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
    assert.ok(!envelope.error && !envelope.result.isError);
    return envelope.result.content[0].text as string;
  };
  let sequence = 0;
  const admission = async (plan: string, name: string, nextIntent?: string) => {
    await mcp(plan);
    const current = await read(plan);
    return rpc("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: current.checks.find((value: any) => value.name === name).checkUri,
      attemptKey: `escalation-${++sequence}`,
      intent: current.currentIntent,
      ...(nextIntent ? { nextIntent } : {}),
    });
  };
  const qualify = async (plan: string, name: string, clean: boolean, nextIntent?: string) => {
    const attempt = await admission(plan, name, nextIntent);
    assert.equal(attempt.status, "ADMITTED", JSON.stringify(attempt));
    const at = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptKey: attempt.attemptKey,
      attemptHandle: attempt.attemptHandle,
      executionId: attempt.executionId,
      checkUri: attempt.checkUri,
      recordedAt: at,
      facts: [
        {
          kind: attempt.operation.operation,
          observedAt: at,
          values: { headRevision: "escalation-head", workingTree: clean ? "clean" : "dirty" },
        },
      ],
    });
    const result = await rpc("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: attempt.attemptHandle,
    });
    assert.equal(result.verdict, clean ? "VALIDATED" : "NOT_VALIDATED");
    return attempt;
  };
  const escalate = async (attempt: any, reason: string) => {
    const result = await rpc("check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: attempt.checkUri,
      attemptHandle: attempt.attemptHandle,
      blockingReason: reason,
      forbiddenFurtherAction: "Change repository state outside the declared scope.",
    });
    return (await read(result.plan)).activeEscalation;
  };
  try {
    await rpc("procedure.publish", {
      source: await readFile(
        path.join(root, "packages/trust-runtime/acceptance/fixtures/intent-chaining.feature"),
        "utf8",
      ),
    });
    await rpc("procedure.publish", { source: wrapper("escalation-level-two", "intent-chaining") });
    await rpc("procedure.publish", { source: wrapper("escalation-level-one", "escalation-level-two") });
    await rpc("procedure.publish", { source: wrapper("escalation-root", "escalation-level-one", true) });
    await rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "escalation-root",
      procedureVersion: "1.0.0",
      plan: "escalation-root",
      environment: "local",
      mode: "dry-run",
      rootInputs: { repository: "repository" },
    });
    await rpc("plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "escalation-root",
      expectedRevision: 1,
      declarations: { selected: "sibling" },
    });
    const initial = await read("escalation-root");
    const first = initial.invocations.find((value: any) => value.name === "nested").childPlan;
    const second = (await read(first)).invocations[0].childPlan;
    const leaf = (await read(second)).invocations[0].childPlan;
    const sibling = initial.invocations.find((value: any) => value.name === "sibling").childPlan;
    assert.equal((await read(first)).checks.length, 0);
    assert.match(
      await mcp(first),
      /PROCEDURE INVOCATIONS/,
      "invocation-only Plans are discoverable without a fake Check URI",
    );
    const stream = await fetch(`${runtime.endpoint}/events/plans`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    let buffer = "";
    const parentNotified = async () => {
      while (true) {
        const next = await reader.read();
        assert.equal(next.done, false);
        buffer += new TextDecoder().decode(next.value);
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.type === "plan.state" && event.plan === "escalation-root") return;
        }
      }
    };
    const leafNegative = await qualify(leaf, "working tree observation", false, "Resolve the leaf observation");
    const leafEscalation = await escalate(leafNegative, "Leaf repository observation cannot be qualified.");
    await parentNotified();
    const blocked = await read("escalation-root");
    assert.equal(blocked.activeEscalation, null);
    assert.equal(blocked.workState, "IN_PROGRESS");
    assert.equal(blocked.descendantEscalations.length, 1);
    const summary = blocked.descendantEscalations[0];
    assert.equal(summary.plan, leaf);
    assert.equal(summary.escalationId, leafEscalation.escalationId);
    assert.equal(summary.path.length, 3);
    assert.equal(summary.path[0].parentPlan, "escalation-root");
    assert.equal(summary.path[2].childPlan, leaf);
    assert.match(summary.blockingReason, /Leaf repository/);
    assert.deepEqual(
      (await rpc("plan.list", {})).plans.find((value: any) => value.plan === "escalation-root").descendantEscalations,
      blocked.descendantEscalations,
    );
    assert.match(await mcp("escalation-root"), /DESCENDANT ESCALATIONS[\s\S]*Leaf repository/);
    assert.equal((await admission("escalation-root", "finish")).status, "REFUSED");
    await qualify(sibling, "working tree observation", true, "Finish sibling independently");
    const siblingNegative = await qualify(sibling, "revision observation", false);
    await escalate(siblingNegative, "Sibling has an independent blocker.");
    assert.equal((await read("escalation-root")).descendantEscalations.length, 2);
    const rootNegative = await qualify("escalation-root", "control", false, "Finish root after resolving children");
    const rootEscalation = await escalate(rootNegative, "Root has its own distinct blocker.");
    await rpc("plan.resume", {
      plan: leaf,
      escalationId: leafEscalation.escalationId,
      resumeReason: "Leaf issue resolved within its scope.",
    });
    await parentNotified();
    const stillRootEscalated = await read("escalation-root");
    assert.equal(stillRootEscalated.activeEscalation.escalationId, rootEscalation.escalationId);
    assert.equal(stillRootEscalated.descendantEscalations.length, 1);
    assert.equal(
      (await admission(leaf, "working tree observation", "Continue the leaf")).status,
      "REFUSED",
      "resuming leaf does not resume its ancestor",
    );
    await rpc("plan.resume", {
      plan: "escalation-root",
      escalationId: rootEscalation.escalationId,
      resumeReason: "Root issue independently resolved.",
    });
    await qualify(leaf, "working tree observation", true, "Finish the remaining leaf Check");
    assert.notEqual((await read("escalation-root")).workState, "COMPLETE");
    const current = await read("escalation-root");
    await rpc("plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "escalation-root",
      expectedRevision: current.revision,
      declarations: { selected: "replacement sibling" },
    });
    const replacement = await read("escalation-root");
    assert.deepEqual(
      replacement.descendantEscalations,
      [],
      "superseded subtree escalations disappear from current root projection",
    );
    assert.ok((await read(sibling)).activeEscalation, "historical escalation remains readable");
    assert.equal((await read(first)).invocations[0].childPlan, second);
  } finally {
    controller.abort();
    await runtime.close();
  }
});
