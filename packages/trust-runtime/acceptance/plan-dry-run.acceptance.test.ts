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

    // A blocked rehearsal starts over: removing it clears its entire Plan context, so the same slug can be
    // engaged again with different root Inputs and no value from the erased Plan survives.
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

test("typed qualification expressions run through JSON Logic and return their computed reason", async () => {
  const runtime = await startPublicRuntime("trust-expression-runtime-", {
    operationsDirectory,
    environments: { unused: { workspaceRoot: repositoryRoot } },
  });
  const source = `# language: en
@trust-dsl:1 @procedure:expression-runtime @version:1.0.0
Feature: Evaluate the typed qualification expression surface

  Background: Plan context
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
      procedureVersion: "3.1.0",
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
    const baseline = await admit(runtime.endpoint, view.actionableChecks[0]!, "stable-baseline-a");
    const baselineUri = baseline.checkUri;
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(baseline, {
      comparedBaseRevision: "revision-a",
      headRevision: "revision-result",
      commitsAhead: 1,
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, baseline.attemptHandle)).verdict, "VALIDATED");

    view = await readPlan(runtime.endpoint, "stable-upstream");
    const consumer = await admit(runtime.endpoint, view.actionableChecks[0]!, "stable-consumer");
    await rpc(runtime.endpoint, "check.attempt.facts", factBatch(consumer, {
      headRevision: "revision-result",
      workingTree: "clean",
    }));
    assert.equal((await finalize(runtime.endpoint, consumer.attemptHandle)).verdict, "VALIDATED");

    view = await readPlan(runtime.endpoint, "stable-upstream");
    assert.equal(view.checks.find((check) => check.name === "consumer")?.state, "SATISFIED");
    await rpc(runtime.endpoint, "plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan: "stable-upstream",
      expectedRevision: view.revision,
      declarations: { "baseline revision": "revision-b" },
    });

    view = await readPlan(runtime.endpoint, "stable-upstream");
    assert.equal(view.checks.find((check) => check.name === "baseline")?.checkUri, baselineUri);
    assert.deepEqual(
      view.checks.map((check) => [check.name, check.state, check.actionable]).sort(),
      [["baseline", "OPEN", true], ["consumer", "OPEN", false]],
    );
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
  attemptKey: string;
  attemptHandle: string;
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
  latestQualification: { newlyOpened: readonly string[] } | null;
  checks: readonly {
    checkUri: string;
    name: string;
    state: string;
    actionable: boolean;
    latestVerdict: string | null;
    inputs: Record<string, unknown>;
  }[];
}

function factBatch(admission: Admission, values: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    contract: "trust.fact-batch-request@1",
    attemptKey: admission.attemptKey,
    attemptHandle: admission.attemptHandle,
    checkUri: admission.checkUri,
    recordedAt: now,
    facts: [{ kind: admission.operation.operation, observedAt: now, values }],
  };
}

async function publish(endpoint: string, file: string): Promise<void> {
  await rpc(endpoint, "procedure.publish", { source: await readFile(file, "utf8"), sourceName: path.basename(file) });
}

async function readPlan(endpoint: string, plan: string): Promise<PlanViewShape> {
  return rpc(endpoint, "plan.read", { plan }) as Promise<PlanViewShape>;
}

async function admit(endpoint: string, checkUri: string, attemptKey: string, reobserve = false): Promise<Admission> {
  return rpc(endpoint, "check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey,
    checkUri,
    ...(reobserve ? { reobserve: true } : {}),
  }) as Promise<Admission>;
}

async function finalize(endpoint: string, attemptHandle: string): Promise<{ verdict: string; reasonCode: string; reason: string }> {
  return rpc(endpoint, "check.attempt.finalize", { contract: "trust.attempt-finalization-request@1", attemptHandle }) as Promise<{ verdict: string; reasonCode: string; reason: string }>;
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
