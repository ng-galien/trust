import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startPublicRuntime } from "./support/runtime-process.js";
import { otlpFactAttributes } from "./support/otlp-fact.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const operationsDirectory = path.join(repositoryRoot, "assets/operations");

/* A dry-run Plan is an operator-driven Plan: it obeys every rule of a live Plan (engagement,
   declarations, admission, Fact validation, qualification, cascade), but the operator supplies
   the Facts over RPC and TRUST never resolves an environment for it. */

test("a dry-run Plan is driven end to end from the RPC boundary without any environment value", async () => {
  const runtime = await startPublicRuntime("trust-dry-run-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  try {
    await publish(runtime.endpoint, path.join(repositoryRoot, "assets/procedures/01-mono-project-change.feature"));

    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "mono-project-change",
      procedureVersion: "1.0.0",
      plan: "rehearsal",
      environment: "local",
      rootInputs: { "jira issue": "PAY-42", project: "payment-api" },
      mode: "dry-run",
    }) as { mode: string; revision: number; checkUris: readonly string[] };
    assert.equal(engagement.mode, "dry-run");
    assert.equal(engagement.revision, 1);

    const catalog = await rpc(runtime.endpoint, "plan.list", {}) as { plans: readonly { plan: string; mode: string }[] };
    assert.deepEqual(catalog.plans.map((plan) => [plan.plan, plan.mode]), [["rehearsal", "dry-run"]]);

    let view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.mode, "dry-run");
    assert.equal(view.actionableChecks.length, 1);
    assert.deepEqual(view.checks.find(({ name }) => name === "issue")?.actionScope, {
      authorized: ["Change and verify only the declared project for the Jira defect."],
      forbidden: ["Alter the Jira evidence, project baseline, or execution environment to make a Check pass."],
    });

    const prematureEscalation = await rpcFailure(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: view.actionableChecks[0],
      attemptHandle: "missing-attempt",
      blockingReason: "No negative Check result exists.",
      forbiddenFurtherAction: "Change external state before observing the Check.",
    });
    assert.equal(prematureEscalation.data?.reason, "check-not-escalatable");

    const prematureReobservation = await admit(
      runtime.endpoint,
      view.actionableChecks[0]!,
      "rehearsal-premature-reobservation",
      true,
    );
    assert.equal(prematureReobservation.status, "REFUSED");

    // Admission follows the live rules but hands out no environment value.
    const first = await admit(runtime.endpoint, view.actionableChecks[0]!, "rehearsal-issue");
    assert.equal(first.status, "ADMITTED");
    assert.equal(first.operation.operation, "jira.issue-read");
    assert.deepEqual(first.environment, {});

    // Facts posted over RPC are validated like runner Facts: an incomplete produced object is rejected.
    const rejected = await rpcFailure(runtime.endpoint, "check.attempt.facts", factBatch(first, { issueType: "defect" }));
    assert.equal(rejected.data?.reason, "fact-batch-rejected");

    const rejectedRunnerFacts = await postOtlpFacts(runtime.endpoint, factBatch(first, {
      issue: "PAY-42",
      summary: "Payment fails on refund",
      issueType: "defect",
      workflowStatus: "todo",
    }));
    assert.equal(rejectedRunnerFacts.partialSuccess?.rejectedSpans, 1);
    assert.equal(rejectedRunnerFacts.partialSuccess?.errorMessage, "fact-batch-rejected");

    const accepted = await rpc(runtime.endpoint, "check.attempt.facts", factBatch(first, {
      issue: "PAY-42",
      summary: "Payment fails on refund",
      issueType: "defect",
      workflowStatus: "todo",
    })) as { acceptedFactIds: readonly string[] };
    assert.equal(accepted.acceptedFactIds.length, 1);

    const validated = await finalize(runtime.endpoint, first.attemptHandle);
    assert.equal(validated.verdict, "VALIDATED");
    assert.equal(validated.reason, "the Jira issue is ready for correction");
    assert.deepEqual(validated.next, {
      action: "RUN_CHECKS",
      checks: [{
        name: "baseline",
        successReason: "the project baseline is clean",
        checkUri: engagement.checkUris.find((uri) => uri.includes("/baseline/")),
        actionScope: {
          authorized: ["Change and verify only the declared project for the Jira defect."],
          forbidden: ["Alter the Jira evidence, project baseline, or execution environment to make a Check pass."],
        },
      }],
    });

    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.revision, 2);
    assert.equal(view.satisfiedChecks, 1);
    assert.equal(view.actionableChecks.length, 1);
    assert.match(view.actionableChecks[0]!, /git-head-read/);

    // A NOT_VALIDATED verdict carries the compiled failure reason and leaves the Check open.
    const second = await admit(runtime.endpoint, view.actionableChecks[0]!, "rehearsal-baseline");
    assert.equal(second.status, "ADMITTED");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(second, { headRevision: "abc123", workingTree: "dirty" }));
    const refused = await finalize(runtime.endpoint, second.attemptHandle);
    assert.equal(refused.verdict, "NOT_VALIDATED");
    assert.equal(refused.reason, "the project has uncommitted changes");

    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.revision, 3);
    assert.equal(view.satisfiedChecks, 1);
    assert.deepEqual(
      view.checks.map((check) => [check.name, check.state, check.latestVerdict]),
      [["baseline", "OPEN", "NOT_VALIDATED"], ["issue", "SATISFIED", "VALIDATED"]],
    );

    const failedCheck = view.checks.find((check) => check.name === "baseline")!;
    assert.equal(failedCheck.escalatable, true);
    assert.match(
      await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: failedCheck.checkUri }),
      /ESCALATION AVAILABLE/,
    );

    // Availability follows the latest Attempt, not an older NOT_VALIDATED Snapshot.
    const pendingRetry = await admit(runtime.endpoint, failedCheck.checkUri, "rehearsal-pending-retry");
    assert.equal(pendingRetry.status, "ADMITTED");
    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.checks.find((check) => check.name === "baseline")?.escalatable, false);
    assert.doesNotMatch(
      await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: failedCheck.checkUri }),
      /ESCALATION AVAILABLE/,
    );
    await interrupt(runtime.endpoint, pendingRetry.attemptHandle);
    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.checks.find((check) => check.name === "baseline")?.escalatable, false);

    const latestFailure = await admit(runtime.endpoint, failedCheck.checkUri, "rehearsal-latest-failure");
    const repeatedObservationAt = new Date().toISOString();
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(latestFailure, { headRevision: "abc123", workingTree: "dirty" }, repeatedObservationAt));
    assert.equal((await finalize(runtime.endpoint, latestFailure.attemptHandle)).verdict, "NOT_VALIDATED");
    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.checks.find((check) => check.name === "baseline")?.escalatable, true);
    const escalationAvailability = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: failedCheck.checkUri });
    assert.ok(escalationAvailability.includes(`- Check URI: ${failedCheck.checkUri}\n  Attempt: ${latestFailure.attemptHandle}`));
    assert.ok((await mcpTool(runtime.endpoint, "trust_check_read", { checkUri: failedCheck.checkUri })).includes(`Attempt: ${latestFailure.attemptHandle}`));

    const whitespaceDeclaration = await rpcFailure(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: failedCheck.checkUri,
      attemptHandle: latestFailure.attemptHandle,
      blockingReason: " ",
      forbiddenFurtherAction: "Discard local changes.",
    });
    assert.equal(whitespaceDeclaration.code, -32_602);
    const oversizedDeclaration = await rpcFailure(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: failedCheck.checkUri,
      attemptHandle: latestFailure.attemptHandle,
      blockingReason: "x".repeat(4_097),
      forbiddenFurtherAction: "Discard local changes.",
    });
    assert.equal(oversizedDeclaration.code, -32_602);

    const missingDeclaration = await mcpToolEnvelope(runtime.endpoint, "trust_check_escalate", {
      checkUri: failedCheck.checkUri,
      attemptHandle: latestFailure.attemptHandle,
      blockingReason: "The repository contains unrelated local changes.",
    });
    assert.equal(missingDeclaration.error?.code, -32_602);

    // Escalation is a declaration about a completed Check; it does not require a still-open Session.
    await rpc(runtime.endpoint, "plan.close", { plan: "rehearsal" });
    assert.equal((await readPlan(runtime.endpoint, "rehearsal")).sessionState, "UNAVAILABLE");

    const escalationInput = {
      checkUri: failedCheck.checkUri,
      attemptHandle: latestFailure.attemptHandle,
      blockingReason: "The repository contains unrelated local changes that cannot be reconciled within this Procedure.",
      forbiddenFurtherAction: "Discard or hide the unrelated changes to manufacture a clean baseline.",
    };
    const escalationText = await mcpTool(runtime.endpoint, "trust_check_escalate", escalationInput);
    assert.match(escalationText, /Result: ESCALATED/);
    assert.match(escalationText, /Only an operator can resume the Plan/);
    const replayedEscalation = await rpc(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      ...escalationInput,
    });

    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.workState, "ESCALATED");
    assert.deepEqual(view.actionableChecks, []);
    assert.equal(view.activeEscalation?.checkUri, failedCheck.checkUri);
    assert.equal(view.activeEscalation?.planRevision, view.revision);
    assert.equal(view.activeEscalation?.snapshotPlanRevision, view.revision - 1);
    assert.equal(view.activeEscalation?.blockingReason, "The repository contains unrelated local changes that cannot be reconciled within this Procedure.");
    assert.equal(view.activeEscalation?.forbiddenFurtherAction, "Discard or hide the unrelated changes to manufacture a clean baseline.");
    assert.equal(view.latestQualification?.verdict, "NOT_VALIDATED");
    assert.deepEqual(replayedEscalation, {
      contract: "trust.check-escalation@1",
      status: "ESCALATED",
      plan: "rehearsal",
      checkUri: failedCheck.checkUri,
      snapshotId: view.activeEscalation?.snapshotId,
      blockingReason: escalationInput.blockingReason,
      forbiddenFurtherAction: escalationInput.forbiddenFurtherAction,
      escalatedAt: view.activeEscalation?.escalatedAt,
    });

    const stoppedAdmission = await admit(runtime.endpoint, failedCheck.checkUri, "rehearsal-while-escalated");
    assert.equal(stoppedAdmission.status, "REFUSED");
    assert.equal(stoppedAdmission.reasonCode, "check-not-actionable");
    const stoppedDeclarations = await rpcFailure(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "rehearsal",
      expectedRevision: view.revision,
      declarations: {},
    });
    assert.equal(stoppedDeclarations.data?.reason, "plan-conflict");

    const firstEscalationId = view.activeEscalation!.escalationId;
    const firstResumeReason = "The operator reconciled the unrelated changes and authorized a retry.";
    assert.equal((await rpcFailure(runtime.endpoint, "plan.resume", { plan: "rehearsal", escalationId: firstEscalationId })).code, -32_602);
    assert.equal((await rpcFailure(runtime.endpoint, "plan.resume", { plan: "rehearsal", escalationId: firstEscalationId, resumeReason: " " })).code, -32_602);
    assert.equal((await rpcFailure(runtime.endpoint, "plan.resume", { plan: "rehearsal", escalationId: firstEscalationId, resumeReason: " padded reason " })).code, -32_602);
    assert.equal((await rpcFailure(runtime.endpoint, "plan.resume", { plan: "rehearsal", escalationId: firstEscalationId, resumeReason: "x".repeat(4_097) })).code, -32_602);
    const resumed = await rpc(runtime.endpoint, "plan.resume", { plan: "rehearsal", escalationId: firstEscalationId, resumeReason: firstResumeReason }) as { status: string; resumeReason: string };
    assert.equal(resumed.status, "RESUMED");
    assert.equal(resumed.resumeReason, firstResumeReason);
    assert.deepEqual(await rpc(runtime.endpoint, "plan.resume", { plan: "rehearsal", escalationId: firstEscalationId, resumeReason: firstResumeReason }), resumed);
    assert.equal((await rpcFailure(runtime.endpoint, "plan.resume", { plan: "rehearsal", escalationId: firstEscalationId, resumeReason: "A different audit explanation." })).data?.reason, "plan-conflict");
    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.workState, "IN_PROGRESS");
    assert.equal(view.sessionState, "OPEN");
    assert.equal(view.activeEscalation, null);
    assert.equal(view.escalations.length, 1);
    assert.notEqual(view.escalations[0]?.resumedAt, null);
    assert.equal(view.escalations[0]?.resumeReason, firstResumeReason);
    assert.deepEqual(view.actionableChecks, [failedCheck.checkUri]);

    // A delayed retry of the accepted escalation is idempotent across the operator resumption.
    assert.deepEqual(await rpc(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      ...escalationInput,
    }), replayedEscalation);
    assert.equal((await readPlan(runtime.endpoint, "rehearsal")).workState, "IN_PROGRESS");

    const repeatedFailure = await admit(runtime.endpoint, failedCheck.checkUri, "rehearsal-repeated-failure");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(repeatedFailure, { headRevision: "abc123", workingTree: "dirty" }, repeatedObservationAt));
    assert.equal((await finalize(runtime.endpoint, repeatedFailure.attemptHandle)).verdict, "NOT_VALIDATED");
    const repeatedCheckRead = await mcpTool(runtime.endpoint, "trust_check_read", { checkUri: failedCheck.checkUri });
    assert.ok(repeatedCheckRead.includes(`ESCALATION AVAILABLE\nCheck URI: ${failedCheck.checkUri}\nAttempt: ${repeatedFailure.attemptHandle}`));
    // Even after a newer negative result, a delayed retry remains correlated to its original Attempt.
    assert.deepEqual(await rpc(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      ...escalationInput,
    }), replayedEscalation);
    assert.equal((await readPlan(runtime.endpoint, "rehearsal")).workState, "IN_PROGRESS");
    await rpc(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: failedCheck.checkUri,
      attemptHandle: repeatedFailure.attemptHandle,
      blockingReason: "The repeated observation still finds unrelated local changes.",
      forbiddenFurtherAction: "Discard those changes to manufacture a clean baseline.",
    });
    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.workState, "ESCALATED");
    assert.equal(view.escalations.length, 2);
    assert.ok(view.escalations[0]!.escalatedAt <= view.escalations[1]!.escalatedAt);
    const secondEscalationId = view.activeEscalation!.escalationId;
    // A delayed retry of the first resumption cannot resume this newer escalation.
    assert.deepEqual(await rpc(runtime.endpoint, "plan.resume", { plan: "rehearsal", escalationId: firstEscalationId, resumeReason: firstResumeReason }), resumed);
    assert.equal((await readPlan(runtime.endpoint, "rehearsal")).workState, "ESCALATED");
    await rpc(runtime.endpoint, "plan.resume", { plan: "rehearsal", escalationId: secondEscalationId, resumeReason: "The operator removed the later blocker and authorized continuation." });
    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.escalations.length, 2);
    assert.ok(view.escalations.every(({ resumedAt }) => resumedAt !== null));

    // Validate the baseline: its produced value materializes "baseline revision", the fix Check appears.
    const third = await admit(runtime.endpoint, view.actionableChecks[0]!, "rehearsal-baseline-again");
    assert.equal(third.status, "ADMITTED");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(third, { headRevision: "abc123", workingTree: "clean" }));
    assert.equal((await finalize(runtime.endpoint, third.attemptHandle)).verdict, "VALIDATED");
    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.equal(view.satisfiedChecks, 2);
    assert.match(view.actionableChecks[0]!, /git-head-compare/);

    // A verdict downstream (fix materializes "fix revision") must not touch the upstream baseline:
    // it stays SATISFIED, not actionable, and only the next Check opens.
    const fourth = await admit(runtime.endpoint, view.actionableChecks[0]!, "rehearsal-fix");
    assert.equal(fourth.status, "ADMITTED");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(fourth, { comparedBaseRevision: "abc123", headRevision: "def456", commitsAhead: 2, workingTree: "clean" }));
    assert.equal((await finalize(runtime.endpoint, fourth.attemptHandle)).verdict, "VALIDATED");
    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.deepEqual(
      view.checks.map((check) => [check.name, check.state, check.actionable]).sort(),
      [["Maven verification", "OPEN", true], ["baseline", "SATISFIED", false], ["fix", "SATISFIED", false], ["issue", "SATISFIED", false]],
    );

    // An explicit dry-run re-observation of the satisfied baseline resets everything below it, in cascade:
    // fix and Maven verification reopen, the baseline stays satisfied with its new value.
    const baselineUri = view.checks.find((check) => check.name === "baseline")?.checkUri;
    assert.ok(baselineUri);
    const later = await admit(runtime.endpoint, baselineUri, "rehearsal-baseline-later", true);
    assert.equal(later.status, "ADMITTED");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(later, { headRevision: "0ff1ce", workingTree: "clean" }));
    const reverdict = await finalize(runtime.endpoint, later.attemptHandle);
    assert.equal(reverdict.verdict, "VALIDATED");
    view = await readPlan(runtime.endpoint, "rehearsal");
    assert.deepEqual(
      view.checks.map((check) => [check.name, check.state, check.actionable]).sort(),
      [["baseline", "SATISFIED", false], ["fix", "OPEN", true], ["issue", "SATISFIED", false]],
    );
    assert.deepEqual(view.latestQualification?.newlyOpened.length, 1);
    const fixAgain = await admit(runtime.endpoint, view.actionableChecks[0]!, "rehearsal-fix-again");
    assert.equal(fixAgain.status, "ADMITTED");
    assert.equal(fixAgain.actionInput.baseRevision, "0ff1ce");

    // The same Plan slug cannot be re-engaged live: mode is part of the Plan identity.
    const conflict = await rpcFailure(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "mono-project-change",
      procedureVersion: "1.0.0",
      plan: "rehearsal",
      environment: "local",
      rootInputs: { "jira issue": "PAY-42", project: "payment-api" },
    });
    assert.equal(conflict.data?.reason, "plan-conflict");

    // Reset is one public operation: it preserves the Plan identity and root Inputs, while clearing every
    // attempt, verdict and revision after the new revision 1.
    const reset = await rpc(runtime.endpoint, "plan.reset", { plan: "rehearsal" }) as { revision: number };
    assert.equal(reset.revision, 1);
    const resetView = await readPlan(runtime.endpoint, "rehearsal");
    assert.deepEqual(resetView.rootInputs, { "jira issue": "PAY-42", project: "payment-api" });
    assert.equal(resetView.revision, 1);
    assert.equal(resetView.satisfiedChecks, 0);
    assert.equal(resetView.latestQualification == null, true);
    assert.equal(resetView.checks.every((check) => check.latestVerdict == null), true);
    const resetCheck = await rpc(runtime.endpoint, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri: resetView.checks[0]!.checkUri,
    }) as { history: unknown[]; attempts: unknown[] };
    assert.deepEqual(resetCheck.history, []);
    assert.deepEqual(resetCheck.attempts, []);

    // Removing a dry-run still clears its entire Plan context, so the same slug can then be engaged with
    // different root Inputs and no value from the erased Plan survives.
    const removed = await rpc(runtime.endpoint, "plan.remove", { plan: "rehearsal" }) as { removed: boolean };
    assert.equal(removed.removed, true);
    assert.deepEqual((await rpc(runtime.endpoint, "plan.list", {}) as { plans: unknown[] }).plans, []);
    const again = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "mono-project-change",
      procedureVersion: "1.0.0",
      plan: "rehearsal",
      environment: "local",
      rootInputs: { "jira issue": "PAY-101", project: "payment-worker" },
      mode: "dry-run",
    }) as { revision: number };
    assert.equal(again.revision, 1);
    const restarted = await readPlan(runtime.endpoint, "rehearsal");
    assert.deepEqual(restarted.rootInputs, { "jira issue": "PAY-101", project: "payment-worker" });
    assert.equal(restarted.checks.find((check) => check.name === "issue")?.inputs.issue, "PAY-101");
    assert.equal(restarted.checks.find((check) => check.name === "baseline")?.inputs.project, "payment-worker");
    assert.equal(JSON.stringify(restarted).includes("PAY-42"), false);
    assert.equal(JSON.stringify(restarted).includes("payment-api"), false);
  } finally {
    await runtime.close();
  }
});

test("a live OTLP-qualified Check exposes its effective scope and may be escalated", async () => {
  const runtime = await startPublicRuntime("trust-live-escalation-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  try {
    await publish(runtime.endpoint, path.join(repositoryRoot, "assets/procedures/00-git-status.feature"));
    await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "live-escalation",
      environment: "local",
      rootInputs: { repository: "trust" },
    });
    let view = await readPlan(runtime.endpoint, "live-escalation");
    const check = view.checks[0]!;
    const expectedScope = {
      authorized: [
        "Read the declared repository state.",
        "Read Git metadata required to observe this Check.",
      ],
      forbidden: [
        "Modify the repository or its environment to obtain the expected state.",
        "Change repository files while observing repository status.",
      ],
    };
    assert.deepEqual(check.actionScope, expectedScope);
    const checkRead = await rpc(runtime.endpoint, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri: check.checkUri,
    }) as { actionScope: unknown; escalatable: boolean };
    assert.deepEqual(checkRead.actionScope, expectedScope);
    assert.equal(checkRead.escalatable, false);

    const admission = await admit(runtime.endpoint, check.checkUri, "live-escalation-attempt");
    await postOtlpFacts(runtime.endpoint, factBatch(admission, {
      headRevision: "abc123",
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, admission.attemptHandle)).verdict, "NOT_VALIDATED");
    view = await readPlan(runtime.endpoint, "live-escalation");
    assert.equal(view.checks[0]?.escalatable, true);

    const escalation = await rpc(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: check.checkUri,
      attemptHandle: admission.attemptHandle,
      blockingReason: "The live repository does not contain the expected local change.",
      forbiddenFurtherAction: "Modify the repository merely to manufacture the expected status.",
    }) as { status: string };
    assert.equal(escalation.status, "ESCALATED");
    assert.equal((await readPlan(runtime.endpoint, "live-escalation")).workState, "ESCALATED");
  } finally {
    await runtime.close();
  }
});

test("escalation serializes with concurrent admission and declaration replacement", async () => {
  const runtime = await startPublicRuntime("trust-escalation-races-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  const source = `# language: en
@trust-dsl:1 @procedure:escalation-race @version:1.0.0
Feature: Serialize escalation with Plan writes

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Read the declared repository. | Modify the repository or environment to make the Check pass. |
    Given one reference "repository"
    And many reference "optional project" declared optionally by agent

  @scenario:status
  Scenario: Read repository status
    Then Check "status" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the repository is dirty"
      """js
      fact.workingTree === "dirty" ||
      fail("the repository is clean")
      """

  @scenario:independent
  Scenario: Read an independent repository status
    Then Check "independent status" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the independent repository observation is dirty"
      """js
      fact.workingTree === "dirty" ||
      fail("the independent repository observation is clean")
      """
`;
  try {
    await rpc(runtime.endpoint, "procedure.publish", { source, sourceName: "escalation-race.feature" });

    const prepareFailure = async (plan: string): Promise<{ checkUri: string; attemptHandle: string; revision: number }> => {
      await rpc(runtime.endpoint, "plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: "escalation-race",
        procedureVersion: "1.0.0",
        plan,
        environment: "local",
        rootInputs: { repository: "trust" },
        mode: "dry-run",
      });
      const initial = await readPlan(runtime.endpoint, plan);
      const failedCheckUri = initial.checks.find(({ name }) => name === "status")!.checkUri;
      const admission = await admit(runtime.endpoint, failedCheckUri, `${plan}-failure`);
      await rpc(runtime.endpoint, "check.attempt.facts", factBatch(admission, {
        headRevision: "abc123",
        workingTree: "clean",
      }));
      assert.equal((await finalize(runtime.endpoint, admission.attemptHandle)).verdict, "NOT_VALIDATED");
      const failed = await readPlan(runtime.endpoint, plan);
      return { checkUri: failed.checks.find(({ name }) => name === "status")!.checkUri, attemptHandle: admission.attemptHandle, revision: failed.revision };
    };

    const declarationPlan = await prepareFailure("declaration-race");
    await Promise.all([
      rpcEnvelope(runtime.endpoint, "check.escalate", {
        contract: "trust.check-escalation-request@1",
        checkUri: declarationPlan.checkUri,
        attemptHandle: declarationPlan.attemptHandle,
        blockingReason: "The Check cannot proceed within its declared scope.",
        forbiddenFurtherAction: "Modify the repository to manufacture the expected state.",
      }),
      rpcEnvelope(runtime.endpoint, "plan.declarations.replace", {
        contract: "trust.plan-declaration-replacement-request@1",
        plan: "declaration-race",
        expectedRevision: declarationPlan.revision,
        declarations: { "optional project": ["secondary"] },
      }),
    ]);
    const afterDeclarationRace = await readPlan(runtime.endpoint, "declaration-race");
    assert.ok(afterDeclarationRace.activeEscalation !== null || afterDeclarationRace.revision === declarationPlan.revision + 1);
    if (afterDeclarationRace.activeEscalation) {
      assert.equal(afterDeclarationRace.activeEscalation.planRevision, afterDeclarationRace.revision);
    }

    const admissionPlan = await prepareFailure("admission-race");
    const [, concurrentAdmission] = await Promise.all([
      rpcEnvelope(runtime.endpoint, "check.escalate", {
        contract: "trust.check-escalation-request@1",
        checkUri: admissionPlan.checkUri,
        attemptHandle: admissionPlan.attemptHandle,
        blockingReason: "The Check cannot proceed within its declared scope.",
        forbiddenFurtherAction: "Modify the repository to manufacture the expected state.",
      }),
      admit(runtime.endpoint, admissionPlan.checkUri, "admission-race-retry"),
    ]);
    const afterAdmissionRace = await readPlan(runtime.endpoint, "admission-race");
    if (afterAdmissionRace.activeEscalation) {
      assert.equal(concurrentAdmission.status, "REFUSED");
      assert.equal(concurrentAdmission.reasonCode, "check-not-actionable");
    } else {
      assert.equal(concurrentAdmission.status, "ADMITTED");
    }

    const pendingPlan = await prepareFailure("pending-other-attempt");
    const pendingView = await readPlan(runtime.endpoint, "pending-other-attempt");
    const otherCheck = pendingView.checks.find(({ name }) => name === "independent status")!;
    const pendingOther = await admit(runtime.endpoint, otherCheck.checkUri, "pending-other-attempt-running");
    assert.equal(pendingOther.status, "ADMITTED");
    const rejectedEscalation = await rpcFailure(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: pendingPlan.checkUri,
      attemptHandle: pendingPlan.attemptHandle,
      blockingReason: "The failed Check cannot proceed within its declared scope.",
      forbiddenFurtherAction: "Modify the repository to manufacture the expected state.",
    });
    assert.equal(rejectedEscalation.data?.reason, "check-not-escalatable");
    await interrupt(runtime.endpoint, pendingOther.attemptHandle);
    assert.equal((await rpc(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: pendingPlan.checkUri,
      attemptHandle: pendingPlan.attemptHandle,
      blockingReason: "The failed Check cannot proceed within its declared scope.",
      forbiddenFurtherAction: "Modify the repository to manufacture the expected state.",
    }) as { status: string }).status, "ESCALATED");
  } finally {
    await runtime.close();
  }
});

test("an expired pending Attempt cannot permanently block escalation", async () => {
  const runtime = await startPublicRuntime("trust-expired-escalation-attempt-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
    sessionDurationMs: 100,
  });
  try {
    await publish(runtime.endpoint, path.join(repositoryRoot, "assets/procedures/00-git-status.feature"));
    const engagementInput = {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "expired-escalation-attempt",
      environment: "local",
      rootInputs: { repository: "trust" },
      mode: "dry-run",
    } as const;
    const engagement = await rpc(runtime.endpoint, "plan.engage", engagementInput) as { checkUris: readonly string[] };
    const checkUri = engagement.checkUris[0]!;

    const firstFailure = await admit(runtime.endpoint, checkUri, "expired-escalation-first-failure");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(firstFailure, { headRevision: "abc123", workingTree: "clean" }));
    assert.equal((await finalize(runtime.endpoint, firstFailure.attemptHandle)).verdict, "NOT_VALIDATED");

    const abandonedRetry = await admit(runtime.endpoint, checkUri, "expired-escalation-abandoned-retry");
    assert.equal(abandonedRetry.status, "ADMITTED");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rpc(runtime.endpoint, "plan.engage", engagementInput);

    const latestFailure = await admit(runtime.endpoint, checkUri, "expired-escalation-latest-failure");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(latestFailure, { headRevision: "abc123", workingTree: "clean" }));
    assert.equal((await finalize(runtime.endpoint, latestFailure.attemptHandle)).verdict, "NOT_VALIDATED");

    const escalation = await rpc(runtime.endpoint, "check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri,
      attemptHandle: latestFailure.attemptHandle,
      blockingReason: "The latest observation still does not establish the required repository state.",
      forbiddenFurtherAction: "Modify the repository merely to manufacture the expected status.",
    }) as { status: string };
    assert.equal(escalation.status, "ESCALATED");
  } finally {
    await runtime.close();
  }
});

test("typed qualification expressions run through JSON Logic and return their computed reason", async () => {
  const runtime = await startPublicRuntime("trust-expression-runtime-", {
    operationsDirectory,
    environments: { unused: { workspaceRoot: repositoryRoot } },
  });
  const source = `# language: en
@trust-dsl:1 @procedure:expression-runtime @version:1.0.0
Feature: Evaluate the typed qualification expression surface

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Perform only the actions declared by this Procedure. | Alter the environment or accepted observations to make a Check pass. |
    Given one reference "project"
    And one reference "baseline revision"
    And many number "limits"
    And one number "threshold"
    And one string "prefix"

  @scenario:surface
  Scenario: Qualify the comparison
    Then Check "surface" runs Operation "git.head-compare"
        on "project" as Input "project"
        using "baseline revision" as Input "baseRevision"
        and must establish "the expression is satisfied"
      """js
      (Math.sqrt(Math.pow(fact.commitsAhead, 2)) >= context.threshold || fail("sqrt and pow failed")) &&
      (Math.min(fact.commitsAhead + 2, Math.max(context.threshold, 1)) >= 1 || fail("min and max failed")) &&
      (context.limits.some(value => value === context.threshold) || fail("some failed")) &&
      (context.limits.every(value => value >= 0) || fail("every failed")) &&
      (context.limits.filter(value => value < 0).every(value => value >= 0) || fail("empty every failed")) &&
      (context.limits.filter(value => value >= 0).length === context.limits.length || fail("filter failed")) &&
      (context.limits.map(value => value + 1).includes(context.threshold + 1) || fail("map failed")) &&
      (context.limits.reduce((total, value) => total + value, 0) >= context.threshold || fail("reduce failed")) &&
      (fact.workingTree.startsWith(context.prefix) || fail("startsWith failed")) &&
      (fact.workingTree.substring(0, 5).toUpperCase().toLowerCase().trim() === "clean" || fail("string transform failed")) &&
      (fact.headRevision !== context["baseline revision"] || fail("strict inequality failed")) &&
      (
        fact.comparedBaseRevision === context["baseline revision"] ||
        fail(\`Expected \${context["baseline revision"]}, observed \${fact.comparedBaseRevision}\`)
      )
      """
`;
  try {
    await rpc(runtime.endpoint, "procedure.publish", { source, sourceName: "expression-runtime.feature" });
    await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "expression-runtime",
      procedureVersion: "1.0.0",
      plan: "expression-runtime",
      environment: "unused",
      rootInputs: {
        project: "payment-api",
        "baseline revision": "base",
        limits: [1, 3],
        threshold: 3,
        prefix: "c",
      },
      mode: "dry-run",
    });
    let view = await readPlan(runtime.endpoint, "expression-runtime");
    const checkUri = view.actionableChecks[0]!;
    const admitted = await admit(runtime.endpoint, checkUri, "expression-pass");
    assert.deepEqual(admitted.actionInput, { project: "payment-api", baseRevision: "base" });
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(admitted, {
      headRevision: "head",
      comparedBaseRevision: "base",
      commitsAhead: 3,
      workingTree: "clean",
    }));
    const passed = await finalize(runtime.endpoint, admitted.attemptHandle);
    assert.equal(passed.verdict, "VALIDATED", JSON.stringify(passed));
    assert.equal(passed.reasonCode, "check-qualified");

    view = await readPlan(runtime.endpoint, "expression-runtime");
    const reobserved = await admit(runtime.endpoint, view.checks[0]!.checkUri, "expression-fail", true);
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(reobserved, {
      headRevision: "head",
      comparedBaseRevision: "other",
      commitsAhead: 3,
      workingTree: "clean",
    }));
    const failed = await finalize(runtime.endpoint, reobserved.attemptHandle);
    assert.equal(failed.verdict, "NOT_VALIDATED");
    assert.equal(failed.reasonCode, "qualification-not-satisfied");
    assert.equal(failed.reason, "Expected base, observed other");
  } finally {
    await runtime.close();
  }
});

test("a live Plan keeps handing out its environment and declarations are replaced over RPC", async () => {
  const runtime = await startPublicRuntime("trust-live-declarations-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  try {
    await publish(runtime.endpoint, path.join(repositoryRoot, "assets/procedures/04-end-to-end-red-green.feature"));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "end-to-end-red-green",
      procedureVersion: "3.2.0",
      plan: "delivery",
      environment: "local",
      rootInputs: { "jira issue": "TK-100" },
    }) as { mode: string; checkUris: readonly string[] };
    assert.equal(engagement.mode, "live");

    let view = await readPlan(runtime.endpoint, "delivery");
    assert.equal(view.mode, "live");
    const forbiddenReobservation = await admit(runtime.endpoint, view.actionableChecks[0]!, "delivery-reobserve", true);
    assert.equal(forbiddenReobservation.status, "REFUSED");
    const admission = await admit(runtime.endpoint, view.actionableChecks[0]!, "delivery-baseline");
    assert.equal(admission.status, "ADMITTED");
    assert.deepEqual(admission.environment, { workspaceRoot: repositoryRoot });

    const operatorFacts = await rpcFailure(runtime.endpoint, "check.attempt.facts", factBatch(admission, {
      baseRevision: "acc000",
      workingTree: "clean",
      branch: "TK-100",
    }));
    assert.equal(operatorFacts.data?.reason, "fact-batch-rejected");

    // A satisfied Check survives a declaration replacement that does not concern it.
    await postOtlpFacts(runtime.endpoint, factBatch(admission, { baseRevision: "acc000", workingTree: "clean", branch: "TK-100" }));
    assert.equal((await finalize(runtime.endpoint, admission.attemptHandle)).verdict, "VALIDATED");
    view = await readPlan(runtime.endpoint, "delivery");
    assert.equal(view.satisfiedChecks, 1);

    // Declarations over RPC call the same runtime function as the MCP tool.
    const replaced = await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "delivery",
      expectedRevision: view.revision,
      declarations: {
        "affected project": ["payment-api", "payment-worker"],
        "test argument": "refund-flow",
      },
    }) as { revision: number; openedCheckUris: readonly string[] };
    assert.equal(replaced.revision, view.revision + 1);
    assert.ok(replaced.openedCheckUris.length > 0);
    view = await readPlan(runtime.endpoint, "delivery");
    assert.deepEqual(view.declarations["affected project"], ["payment-api", "payment-worker"]);
    assert.equal(view.satisfiedChecks, 1);
    assert.deepEqual(view.checks.filter((check) => check.name === "acceptance baseline").map((check) => check.state), ["SATISFIED"]);

    const stale = await rpcFailure(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "delivery",
      expectedRevision: 1,
      declarations: { "affected project": ["payment-api"] },
    });
    assert.equal(stale.data?.reason, "plan-conflict");

    // A live Plan is audit history: it cannot be removed.
    const refused = await rpcFailure(runtime.endpoint, "plan.remove", { plan: "delivery" });
    assert.equal(refused.data?.reason, "plan-conflict");
  } finally {
    await runtime.close();
  }
});

test("a declaration change reopens a Check when its exact upstream Checks change", async () => {
  const runtime = await startPublicRuntime("trust-check-field-dependency-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  try {
    await publish(
      runtime.endpoint,
      path.join(repositoryRoot, "packages/trust-runtime/acceptance/fixtures/check-field-dependency.feature"),
    );
    await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "check-field-dependency",
      procedureVersion: "1.0.0",
      plan: "dependency-change",
      environment: "local",
      rootInputs: { workspace: "workspace" },
      mode: "dry-run",
    });
    let view = await readPlan(runtime.endpoint, "dependency-change");
    await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "dependency-change",
      expectedRevision: view.revision,
      declarations: { project: ["project-a"] },
    });

    view = await readPlan(runtime.endpoint, "dependency-change");
    const baseline = await admit(runtime.endpoint, view.actionableChecks[0]!, "dependency-baseline-a");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(baseline, {
      headRevision: "revision-a",
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, baseline.attemptHandle)).verdict, "VALIDATED");

    view = await readPlan(runtime.endpoint, "dependency-change");
    const workspace = await admit(runtime.endpoint, view.actionableChecks[0]!, "dependency-workspace");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(workspace, {
      headRevision: "revision-a",
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, workspace.attemptHandle)).verdict, "VALIDATED");

    view = await readPlan(runtime.endpoint, "dependency-change");
    assert.equal(view.checks.find((check) => check.name === "workspace")?.state, "SATISFIED");
    await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "dependency-change",
      expectedRevision: view.revision,
      declarations: { project: ["project-a", "project-b"] },
    });

    view = await readPlan(runtime.endpoint, "dependency-change");
    const workspaceAfterChange = view.checks.find((check) => check.name === "workspace");
    assert.equal(workspaceAfterChange?.state, "OPEN");
    assert.equal(workspaceAfterChange?.actionable, false);
    assert.equal(view.checks.filter((check) => check.name === "baseline" && check.state === "OPEN").length, 1);
  } finally {
    await runtime.close();
  }
});

test("a declaration change reopens downstream Checks when an upstream Check keeps the same URI", async () => {
  const runtime = await startPublicRuntime("trust-stable-upstream-uri-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  try {
    await publish(
      runtime.endpoint,
      path.join(repositoryRoot, "packages/trust-runtime/acceptance/fixtures/stable-upstream-uri.feature"),
    );
    await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "stable-upstream-uri",
      procedureVersion: "1.0.0",
      plan: "stable-upstream",
      environment: "local",
      rootInputs: { workspace: "workspace" },
      mode: "dry-run",
    });
    let view = await readPlan(runtime.endpoint, "stable-upstream");
    await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "stable-upstream",
      expectedRevision: view.revision,
      declarations: { "baseline revision": "revision-a" },
    });

    view = await readPlan(runtime.endpoint, "stable-upstream");
    assert.equal(view.intentChainState, "ACTIVE");
    assert.ok(view.currentIntent);
    const baseline = await admit(runtime.endpoint, view.actionableChecks[0]!, "stable-baseline-a", false, {
      intent: view.currentIntent,
      nextIntent: "Confirm the resulting revision",
    });
    const baselineUri = baseline.checkUri;
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(baseline, {
      comparedBaseRevision: "revision-a",
      headRevision: "revision-result",
      commitsAhead: 1,
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, baseline.attemptHandle)).verdict, "VALIDATED");

    view = await readPlan(runtime.endpoint, "stable-upstream");
    assert.equal(view.currentIntent, "Confirm the resulting revision");
    const consumer = await admit(runtime.endpoint, view.actionableChecks[0]!, "stable-consumer", false, {
      intent: view.currentIntent,
    });
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(consumer, {
      headRevision: "revision-result",
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, consumer.attemptHandle)).verdict, "VALIDATED");

    view = await readPlan(runtime.endpoint, "stable-upstream");
    assert.equal(view.checks.find((check) => check.name === "consumer")?.state, "SATISFIED");
    assert.equal(view.intentChainState, "COMPLETE");
    assert.equal(view.currentIntent, null);

    const refusedReobservation = await admit(
      runtime.endpoint,
      consumer.checkUri,
      "stable-consumer-refused-reobservation",
      true,
      { nextIntent: "This leaf Check cannot continue the completed Plan" },
    );
    assert.equal(refusedReobservation.status, "REFUSED");
    assert.equal(refusedReobservation.reasonCode, "next-intent-unexpected");
    view = await readPlan(runtime.endpoint, "stable-upstream");
    assert.equal(view.intentChainState, "COMPLETE");
    assert.equal(view.currentIntent, null);

    const reobserved = await admit(runtime.endpoint, baselineUri, "stable-baseline-reobserved", true, {
      nextIntent: "Confirm the re-observed revision",
    });
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(reobserved, {
      comparedBaseRevision: "revision-a",
      headRevision: "revision-result",
      commitsAhead: 1,
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, reobserved.attemptHandle)).verdict, "VALIDATED");
    view = await readPlan(runtime.endpoint, "stable-upstream");
    assert.equal(view.intentChainState, "ACTIVE");
    assert.equal(view.currentIntent, "Confirm the re-observed revision");
    assert.equal(view.checks.find((check) => check.name === "consumer")?.state, "OPEN");

    const revalidated = await admit(runtime.endpoint, consumer.checkUri, "stable-consumer-revalidated", false, {
      intent: view.currentIntent!,
    });
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(revalidated, {
      headRevision: "revision-result",
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, revalidated.attemptHandle)).verdict, "VALIDATED");
    view = await readPlan(runtime.endpoint, "stable-upstream");
    assert.equal(view.intentChainState, "COMPLETE");

    await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "stable-upstream",
      expectedRevision: view.revision,
      declarations: { "baseline revision": "revision-b" },
    });

    view = await readPlan(runtime.endpoint, "stable-upstream");
    assert.equal(view.intentChainState, "ACTIVE");
    assert.ok(view.currentIntent);
    assert.equal(view.checks.find((check) => check.name === "baseline")?.checkUri, baselineUri);
    assert.deepEqual(
      view.checks.map((check) => [check.name, check.state, check.actionable]).sort(),
      [["baseline", "OPEN", true], ["consumer", "OPEN", false]],
    );
  } finally {
    await runtime.close();
  }
});

test("declaration replacement cannot overtake an intent Attempt and completes a chain when it removes the remaining Check", async () => {
  const runtime = await startPublicRuntime("trust-intent-declaration-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  try {
    await publish(
      runtime.endpoint,
      path.join(repositoryRoot, "packages/trust-runtime/acceptance/fixtures/intent-declaration.feature"),
    );
    await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "intent-declaration",
      procedureVersion: "1.0.0",
      plan: "intent-declaration",
      environment: "local",
      rootInputs: {},
      mode: "dry-run",
    });
    let view = await readPlan(runtime.endpoint, "intent-declaration");
    assert.equal(view.intentChainState, "ACTIVE");
    await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "intent-declaration",
      expectedRevision: view.revision,
      declarations: { project: ["project-a", "project-b"] },
    });
    view = await readPlan(runtime.endpoint, "intent-declaration");
    assert.equal(view.actionableChecks.length, 2);
    const currentIntent = view.currentIntent!;
    const selected = view.checks.find((check) => check.checkUri === view.actionableChecks[0]);
    assert.ok(selected);
    const retainedProject = String(selected.inputs.project);
    const pending = await admit(runtime.endpoint, selected.checkUri, "intent-declaration-pending", false, {
      intent: currentIntent,
      nextIntent: "Finish the remaining declared project",
    });
    const blockedReplacement = await rpcFailure(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "intent-declaration",
      expectedRevision: view.revision,
      declarations: { project: [retainedProject] },
    });
    assert.equal(blockedReplacement.data?.reason, "plan-conflict");
    const whilePending = await readPlan(runtime.endpoint, "intent-declaration");
    assert.equal(whilePending.revision, view.revision);
    assert.equal(whilePending.currentIntent, currentIntent);

    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(pending, {
      headRevision: "revision-a",
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, pending.attemptHandle)).verdict, "VALIDATED");
    view = await readPlan(runtime.endpoint, "intent-declaration");
    assert.equal(view.intentChainState, "ACTIVE");
    await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "intent-declaration",
      expectedRevision: view.revision,
      declarations: { project: [retainedProject] },
    });
    view = await readPlan(runtime.endpoint, "intent-declaration");
    assert.equal(view.checks.length, 1);
    assert.equal(view.checks[0]?.state, "SATISFIED");
    assert.equal(view.intentChainState, "COMPLETE");
    assert.equal(view.currentIntent, null);

    await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "intent-declaration",
      procedureVersion: "1.0.0",
      plan: "intent-declaration-closed",
      environment: "local",
      rootInputs: {},
      mode: "dry-run",
    });
    let closedView = await readPlan(runtime.endpoint, "intent-declaration-closed");
    await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "intent-declaration-closed",
      expectedRevision: closedView.revision,
      declarations: { project: ["project-a", "project-b"] },
    });
    closedView = await readPlan(runtime.endpoint, "intent-declaration-closed");
    const closedAttempt = await admit(runtime.endpoint, closedView.actionableChecks[0]!, "intent-declaration-closed-pending", false, {
      intent: closedView.currentIntent!,
      nextIntent: "Finish the remaining project after reopening",
    });
    await rpc(runtime.endpoint, "plan.close", { plan: "intent-declaration-closed" });
    const replacementAfterClose = await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "intent-declaration-closed",
      expectedRevision: closedView.revision,
      declarations: { project: ["project-a"] },
    }) as { revision: number };
    assert.equal(replacementAfterClose.revision, closedView.revision + 1);
    const staleFactsAfterClose = await rpcFailure(
      runtime.endpoint,
      "check.attempt.facts",
      factBatch(closedAttempt, { headRevision: "stale-revision", workingTree: "clean" }),
    );
    assert.equal(staleFactsAfterClose.data?.reason, "fact-batch-rejected");
    closedView = await readPlan(runtime.endpoint, "intent-declaration-closed");
    assert.equal(closedView.checks.length, 1);
    assert.equal(closedView.actionableChecks.length, 1);
  } finally {
    await runtime.close();
  }
});

test("a Check bound with using plan receives the Plan identifier in its admitted action input", async () => {
  const runtime = await startPublicRuntime("trust-plan-identifier-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  try {
    await publish(
      runtime.endpoint,
      path.join(repositoryRoot, "packages/trust-runtime/acceptance/fixtures/plan-identifier-binding.feature"),
    );
    await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "plan-identifier-binding",
      procedureVersion: "1.0.0",
      plan: "release-2026-08",
      environment: "local",
      rootInputs: { project: "payment-api" },
      mode: "dry-run",
    });

    const view = await readPlan(runtime.endpoint, "release-2026-08");
    assert.equal(view.actionableChecks.length, 1);
    assert.deepEqual(view.checks[0]?.inputs, { project: "payment-api", baseRevision: "release-2026-08" });
    // `using plan` binds the synthesised role "plan": the Plan identifier is ordinary Check context.
    const detail = await rpc(runtime.endpoint, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri: view.actionableChecks[0]!,
    }) as { context: Record<string, unknown> };
    assert.deepEqual(detail.context, { project: "payment-api", plan: "release-2026-08" });

    const admission = await admit(runtime.endpoint, view.actionableChecks[0]!, "plan-identifier-comparison");
    assert.equal(admission.status, "ADMITTED");
    assert.deepEqual(admission.actionInput, { project: "payment-api", baseRevision: "release-2026-08" });
  } finally {
    await runtime.close();
  }
});

interface Admission {
  status: string;
  reasonCode?: string;
  attemptKey: string;
  attemptHandle: string;
  executionId: string;
  checkUri: string;
  operation: { operation: string };
  actionInput: Record<string, unknown>;
  environment: Record<string, unknown>;
}

interface PlanViewShape {
  mode: string;
  revision: number;
  satisfiedChecks: number;
  actionableChecks: readonly string[];
  declarations: Record<string, unknown>;
  rootInputs: Record<string, unknown>;
  intentChainState: string;
  currentIntent: string | null;
  sessionState: string;
  workState: string;
  latestQualification: { verdict: string; newlyOpened: readonly string[] } | null;
  activeEscalation: {
    escalationId: string;
    planRevision: number;
    snapshotPlanRevision: number;
    checkUri: string;
    blockingReason: string;
    forbiddenFurtherAction: string;
    snapshotId: string;
    escalatedAt: string;
  } | null;
  escalations: readonly { escalationId: string; escalatedAt: string; resumedAt: string | null; resumeReason: string | null }[];
  checks: readonly {
    checkUri: string;
    name: string;
    state: string;
    actionable: boolean;
    escalatable: boolean;
    latestVerdict: string | null;
    inputs: Record<string, unknown>;
    actionScope: { authorized: readonly string[]; forbidden: readonly string[] };
  }[];
}

function factBatch(admission: Admission, values: Record<string, unknown>, observedAt = new Date().toISOString()) {
  const now = new Date().toISOString();
  return {
    contract: "trust.fact-batch-request@1",
    attemptKey: admission.attemptKey,
    attemptHandle: admission.attemptHandle,
    executionId: admission.executionId,
    checkUri: admission.checkUri,
    recordedAt: now,
    facts: [{ kind: admission.operation.operation, observedAt, values }],
  };
}

async function publish(endpoint: string, file: string): Promise<void> {
  await rpc(endpoint, "procedure.publish", { source: await readFile(file, "utf8"), sourceName: path.basename(file) });
}

async function readPlan(endpoint: string, plan: string): Promise<PlanViewShape> {
  return rpc(endpoint, "plan.read", { plan }) as Promise<PlanViewShape>;
}

async function admit(
  endpoint: string,
  checkUri: string,
  attemptKey: string,
  reobserve = false,
  intents: { readonly intent?: string; readonly nextIntent?: string } = {},
): Promise<Admission> {
  return rpc(endpoint, "check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey,
    checkUri,
    ...(reobserve ? { reobserve: true } : {}),
    ...intents,
  }) as Promise<Admission>;
}

async function finalize(endpoint: string, attemptHandle: string): Promise<{
  verdict: string;
  reasonCode: string;
  reason: string;
  next: unknown;
}> {
  return rpc(endpoint, "check.attempt.finalize", { contract: "trust.attempt-finalization-request@1", attemptHandle }) as Promise<{
    verdict: string;
    reasonCode: string;
    reason: string;
    next: unknown;
  }>;
}

async function interrupt(endpoint: string, attemptHandle: string): Promise<void> {
  await rpc(endpoint, "check.attempt.interrupt", {
    contract: "trust.attempt-interruption-request@1",
    attemptHandle,
  });
}

async function postOtlpFacts(endpoint: string, batch: ReturnType<typeof factBatch>): Promise<{
  partialSuccess?: { rejectedSpans?: number; errorMessage?: string };
}> {
  const response = await fetch(`${endpoint}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{ spans: [{
          name: "trust.runner.facts",
          startTimeUnixNano: `${BigInt(Date.parse(batch.recordedAt)) * 1_000_000n}`,
          attributes: [
            attribute("trust.attempt_key", batch.attemptKey),
            attribute("trust.attempt_handle", batch.attemptHandle),
            attribute("trust.execution_id", batch.executionId),
            attribute("trust.check_uri", batch.checkUri),
          ],
          events: batch.facts.map((fact, index) => ({
            name: "trust.runner.fact",
            attributes: otlpFactAttributes(fact, index),
          })),
        }] }],
      }],
    }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ partialSuccess?: { rejectedSpans?: number; errorMessage?: string } }>;
}

function attribute(key: string, value: unknown) {
  if (typeof value === "number") return { key, value: { intValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}

async function rpcFailure(endpoint: string, method: string, params: unknown) {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.notEqual(envelope.error, undefined);
  return envelope.error!;
}

async function rpcEnvelope(endpoint: string, method: string, params: unknown): Promise<{
  result?: unknown;
  error?: { code: number; message: string; data?: { reason?: string } };
}> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ result?: unknown; error?: { code: number; message: string; data?: { reason?: string } } }>;
}

async function mcpTool(
  endpoint: string,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string> {
  const envelope = await mcpToolEnvelope(endpoint, name, arguments_);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  assert.notEqual(envelope.result?.isError, true, envelope.result?.content?.[0]?.text);
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return text!;
}

async function mcpToolEnvelope(
  endpoint: string,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<{
  result?: { content?: readonly { type?: string; text?: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}> {
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    result?: { content?: readonly { type?: string; text?: string }[]; isError?: boolean };
    error?: { code: number; message: string };
  }>;
}
