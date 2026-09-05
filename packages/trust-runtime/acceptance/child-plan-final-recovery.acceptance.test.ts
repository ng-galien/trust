import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const source = (
  level: number,
  intentChaining: boolean,
) => `@trust-dsl:1 @procedure:recovery-${level} @version:1.0.0 ${intentChaining ? "@intent-chaining" : ""}
Feature: Recovery level ${level}
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe the repository. | Modify external state. |
    And one reference "repository"
${
  level < 3
    ? `  @scenario:child
  Scenario: Complete the independent child
    Then Invocation "child" runs Procedure "recovery-${level + 1}@1.0.0" on "repository" as Input "repository" and must establish "child complete"
`
    : ""
}  @scenario:final
  Scenario: Complete this level
${level < 3 ? '    Given scenario "child" is validated\n' : ""}    Then Check "final" runs Operation "git.head-read@*" on "repository" as Input "project" and must establish "local completion"
      """js
      fact.workingTree === "clean" || fail("not clean")
      """
`;

for (const heldLevel of [0, 1])
  for (const intentChaining of [true, false])
    test(`four-level held final at level ${heldLevel} retains Facts, refuses stale replay and recovers bottom-up (intent chaining ${intentChaining})`, {
      timeout: 40_000,
    }, async () => {
      const runtime = await startPublicRuntime("trust-final-recovery-", {
        operationsDirectory: path.join(root, "assets/operations"),
        environments: { local: { workspaceRoot: root } },
      });
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
      let sequence = 0;
      const admit = async (plan: string, reobserve = false) => {
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
        assert.ok(!((await response.json()) as any).result.isError);
        const view = await read(plan);
        const result = await rpc("check.attempt.admit", {
          contract: "trust.check-admission-request@1",
          checkUri: view.checks[0].checkUri,
          attemptKey: `recovery-${++sequence}`,
          ...(view.currentIntent ? { intent: view.currentIntent } : {}),
          ...(reobserve ? { reobserve } : {}),
        });
        assert.equal(result.status, "ADMITTED", JSON.stringify(result));
        return result;
      };
      const facts = (attempt: any, workingTree = "clean") => {
        const observedAt = new Date().toISOString();
        return rpc("check.attempt.facts", {
          contract: "trust.fact-batch-request@1",
          attemptKey: attempt.attemptKey,
          attemptHandle: attempt.attemptHandle,
          executionId: attempt.executionId,
          checkUri: attempt.checkUri,
          recordedAt: observedAt,
          facts: [{ kind: attempt.operation.operation, observedAt, values: { workingTree, headRevision: "revision" } }],
        });
      };
      const finalize = (attempt: any, failure = false) =>
        rpc(
          "check.attempt.finalize",
          { contract: "trust.attempt-finalization-request@1", attemptHandle: attempt.attemptHandle },
          failure,
        );
      const finish = async (plan: string, dirty = false, reobserve = false) => {
        const attempt = await admit(plan, reobserve);
        await facts(attempt, dirty ? "dirty" : "clean");
        assert.equal((await finalize(attempt)).verdict, dirty ? "NOT_VALIDATED" : "VALIDATED");
      };
      try {
        for (let level = 3; level >= 0; level--)
          await rpc("procedure.publish", { source: source(level, intentChaining) });
        await rpc("plan.engage", {
          contract: "trust.plan-engagement-request@1",
          procedure: "recovery-0",
          procedureVersion: "1.0.0",
          plan: "recovery-root",
          mode: "dry-run",
          environment: "local",
          rootInputs: { repository: "repository" },
        });
        const plans = ["recovery-root"];
        for (let level = 0; level < 3; level++) plans.push((await read(plans[level]!)).invocations[0].childPlan);
        const identities = await Promise.all(plans.map(read));
        for (let level = 3; level > heldLevel; level--) await finish(plans[level]!);
        const heldPlan = plans[heldLevel]!;
        const held = await admit(heldPlan);
        const rootIntent = (await read(heldPlan)).currentIntent;
        // Accepted Facts are deliberately held before finalization; no timing-based race.
        await facts(held);
        await finish(plans[3]!, true, true);
        assert.match(JSON.stringify(await finalize(held, true)), /plan-conflict/);
        const historical = await rpc("check.read", { contract: "trust.check-read-request@1", checkUri: held.checkUri });
        assert.equal(historical.attempts.find((value: any) => value.handle === held.attemptHandle).facts.length, 1);
        assert.equal((await read(heldPlan)).currentIntent, rootIntent);
        for (let level = 0; level < 3; level++) assert.equal((await read(plans[level]!)).checks[0].state, "OPEN");
        for (let level = 3; level > heldLevel; level--) await finish(plans[level]!);
        const replay = await rpc("check.attempt.admit", {
          contract: "trust.check-admission-request@1",
          checkUri: held.checkUri,
          attemptKey: held.attemptKey,
          ...(rootIntent ? { intent: rootIntent } : {}),
        });
        assert.equal(
          replay.status,
          "REFUSED",
          "a stale key must not delegate its external action again after readiness returns",
        );
        const fresh = await admit(heldPlan);
        // A late stale response cannot release the replacement Attempt's reservation.
        assert.match(JSON.stringify(await finalize(held, true)), /plan-conflict/);
        if (intentChaining) {
          const competing = await rpc("check.attempt.admit", {
            contract: "trust.check-admission-request@1",
            checkUri: fresh.checkUri,
            attemptKey: "competing-final",
            intent: rootIntent,
          });
          assert.equal(competing.reasonCode, "intent-in-use");
        }
        await facts(fresh);
        assert.equal((await finalize(fresh)).verdict, "VALIDATED");
        for (let level = heldLevel - 1; level >= 0; level--) await finish(plans[level]!);
        assert.equal((await read(plans[0]!)).workState, "COMPLETE");
        assert.equal((await finalize(fresh)).verdict, "VALIDATED", "finalization replay is idempotent");
        assert.equal(
          (await rpc("check.read", { contract: "trust.check-read-request@1", checkUri: held.checkUri })).attempts.find(
            (value: any) => value.handle === held.attemptHandle,
          ).facts.length,
          1,
        );
        for (let level = 1; level < 4; level++)
          assert.deepEqual((await read(plans[level]!)).parent, identities[level].parent);
      } finally {
        await runtime.close();
      }
    });
