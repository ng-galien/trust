import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startPublicRuntime } from "./support/runtime-process.js";
import { otlpFactAttributes } from "./support/otlp-fact.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const operationsDirectory = path.join(repositoryRoot, "assets/operations");

test("a Plan engages before future agent declarations exist", async () => {
  const runtime = await startRuntime("trust-future-declarations-");
  try {
    const procedureFile = path.join(
      repositoryRoot,
      "assets/procedures/04-end-to-end-red-green.feature",
    );
    const procedureSource = await readFile(procedureFile, "utf8");
    await publish(runtime.endpoint, procedureFile);
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "end-to-end-red-green",
      procedureVersion: "3.2.0",
      plan: "future-declarations",
      environment: "local",
      rootInputs: { "jira issue": "TK-100" },
    }) as { revision: number; checkUris: readonly string[] };

    assert.equal(engagement.revision, 1);
    assert.equal(engagement.checkUris.length, 3);
    assert.ok(engagement.checkUris.some((uri) => uri.includes("git-change-start")));
    assert.ok(engagement.checkUris.some((uri) => uri.includes("jira-issue-read")));
    assert.ok(engagement.checkUris.some((uri) => uri.includes("git-change-merge")));

    const plan = await mcpTool(runtime.endpoint, "trust_plan_read", {
      checkUri: engagement.checkUris[0],
    });
    assert.match(plan, /NEXT\nYou can act now:/);
    assert.match(plan, /Run 1 actionable Check with the TRUST Skill/);
    assert.match(plan, /Declare 5 missing declaration roles with trust_plan_declarations_replace/);
    assert.match(plan, /- affected project: many reference; parent: jira issue/);
    assert.match(plan, /- trace: one reference\n  Value shape: <reference>/);
    assert.doesNotMatch(plan, /Declaration roles: \[/);

    const firstPageText = await mcpTool(runtime.endpoint, "trust_procedure_read", {
      checkUri: engagement.checkUris[0],
      limit: 900,
    });
    assert.match(firstPageText, /\n\n\nREAD STATUS\nComplete: no/);
    const firstPage = parseProcedurePage(firstPageText);
    assert.equal(firstPage.complete, false);
    assert.ok(firstPage.nextCursor);

    const alteredCursor = `${firstPage.nextCursor.slice(0, -1)}${
      firstPage.nextCursor.endsWith("a") ? "b" : "a"
    }`;
    assert.match(
      await mcpToolFailure(runtime.endpoint, "trust_procedure_read", {
        checkUri: engagement.checkUris[0],
        cursor: alteredCursor,
        limit: 900,
      }),
      /cursor is invalid/,
    );
    assert.match(
      await mcpToolFailure(runtime.endpoint, "trust_procedure_read", {
        checkUri: engagement.checkUris[1],
        cursor: firstPage.nextCursor,
        limit: 900,
      }),
      /cursor is invalid/,
    );

    let reconstructed = firstPage.source;
    let cursor: string | undefined = firstPage.nextCursor;
    while (cursor !== undefined) {
      const page = parseProcedurePage(await mcpTool(runtime.endpoint, "trust_procedure_read", {
        checkUri: engagement.checkUris[0],
        cursor,
        limit: 900,
      }));
      reconstructed += page.source;
      cursor = page.nextCursor;
      if (cursor === undefined) assert.equal(page.complete, true);
    }
    assert.equal(reconstructed, procedureSource);
  } finally {
    await runtime.close();
  }
});

test("optional agent declarations may be absent and create Checks only when supplied", async () => {
  const runtime = await startRuntime("trust-optional-declarations-");
  try {
    await publish(runtime.endpoint, fixture("optional-agent-declarations.feature"));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "optional-agent-declarations",
      procedureVersion: "1.0.0",
      plan: "optional-agent-declarations",
      environment: "local",
      rootInputs: { workspace: "packages/trust-runtime" },
    }) as { revision: number; checkUris: readonly string[] };

    assert.equal(engagement.revision, 1);
    assert.equal(engagement.checkUris.length, 3);
    const initialView = await rpc(runtime.endpoint, "plan.read", {
      plan: "optional-agent-declarations",
    }) as {
      missingDeclarations: readonly string[];
      declarationRoles: readonly { role: string; optional: boolean }[];
      checks: readonly { name: string }[];
    };
    assert.deepEqual(initialView.missingDeclarations, ["required note"]);
    assert.deepEqual(
      initialView.checks.map(({ name }) => name).sort(),
      ["after optional check observation", "after optional targets", "workspace head"],
    );
    assert.equal(initialView.declarationRoles.find(({ role }) => role === "optional project")?.optional, true);
    assert.equal(initialView.declarationRoles.find(({ role }) => role === "optional target")?.optional, true);
    const initial = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: engagement.checkUris[0] });
    assert.match(initial, /Declare 1 missing declaration role with trust_plan_declarations_replace/);
    assert.match(initial, /OPTIONAL DECLARATIONS/);
    assert.match(initial, /- optional project: one reference; optional/);
    assert.match(initial, /- optional target: many reference; optional/);

    assert.match(await mcpToolFailure(runtime.endpoint, "trust_plan_declarations_replace", {
      plan: "optional-agent-declarations",
      expectedRevision: 1,
      declarations: {
        "required note": "covered",
        "optional target": [],
      },
    }), /Role "optional target" must contain values/);

    const replacement = await mcpTool(runtime.endpoint, "trust_plan_declarations_replace", {
      plan: "optional-agent-declarations",
      expectedRevision: 1,
      declarations: {
        "required note": "covered",
        "optional project": "packages/trust-procedure",
        "optional target": ["packages/trust-ui", "packages/trust-language-server"],
      },
    });
    assert.match(replacement, /Revision: 2/);
    assert.match(replacement, /Current Checks: 10/);
    const expanded = await rpc(runtime.endpoint, "plan.read", {
      plan: "optional-agent-declarations",
    }) as { checks: readonly { checkUri: string; name: string; blockedBy: readonly string[] }[] };
    const observed = expanded.checks.find(({ name }) => name === "optional observed head");
    assert.ok(observed);
    assert.equal(observed.blockedBy.length, 1);
    assert.ok(expanded.checks.some(({ name }) => name === "optional transitive head"));
    assert.equal(
      expanded.checks.find(({ name }) => name === "after optional check observation")?.blockedBy.length,
      1,
    );
    assert.equal(
      expanded.checks.find(({ name }) => name === "after optional targets")?.blockedBy.length,
      2,
    );

    const materialization = expanded.checks.find(({ name }) => name === "optional materialization");
    assert.ok(materialization);
    const materializationAdmission = await admit(
      runtime.endpoint,
      materialization.checkUri,
      "optional-declarations-materialization",
    );
    await sendRunnerFacts(
      runtime.endpoint,
      materializationAdmission,
      gitHeadFact(materializationAdmission.operation.operation),
    );
    await rpc(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: materializationAdmission.attemptHandle,
    });
    const materialized = await rpc(runtime.endpoint, "plan.read", {
      plan: "optional-agent-declarations",
    }) as { revision: number };
    assert.equal(materialized.revision, 3);

    const removal = await mcpTool(runtime.endpoint, "trust_plan_declarations_replace", {
      plan: "optional-agent-declarations",
      expectedRevision: 3,
      declarations: { "required note": "covered" },
    });
    assert.match(removal, /Revision: 4/);
    assert.match(removal, /Current Checks: 3/);
    assert.match(removal, /Removed Checks: 7/);

    const resumed = await rpc(runtime.endpoint, "plan.read", {
      plan: "optional-agent-declarations",
    }) as { checks: readonly { checkUri: string }[] };
    for (const [index, check] of resumed.checks.entries()) {
      const admission = await admit(
        runtime.endpoint,
        check.checkUri,
        `optional-declarations-complete-${index}`,
      );
      await sendRunnerFacts(runtime.endpoint, admission, gitHeadFact(admission.operation.operation));
      await rpc(runtime.endpoint, "check.attempt.finalize", {
        contract: "trust.attempt-finalization-request@1",
        attemptHandle: admission.attemptHandle,
      });
    }
    const complete = await rpc(runtime.endpoint, "plan.read", {
      plan: "optional-agent-declarations",
    }) as { workState: string; checklistComplete: boolean };
    assert.equal(complete.workState, "COMPLETE");
    assert.equal(complete.checklistComplete, true);
  } finally {
    await runtime.close();
  }
});

test("an intent-chained Plan initializes on first read, survives resumption and rotates after each validated Check", async () => {
  const runtime = await startRuntime("trust-intent-chaining-");
  try {
    await publish(runtime.endpoint, fixture("intent-chaining.feature"));
    const concurrencyEngagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "intent-chaining",
      procedureVersion: "1.0.0",
      plan: "intent-concurrency",
      environment: "local",
      rootInputs: { repository: "trust" },
    }) as { checkUris: readonly string[] };
    const concurrencyRead = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: concurrencyEngagement.checkUris[0] });
    const concurrencyIntent = /^Current intent: (.+)$/m.exec(concurrencyRead)?.[1];
    assert.ok(concurrencyIntent);
    const concurrentAdmissions = await Promise.all(concurrencyEngagement.checkUris.map((checkUri, index) => (
      rpc(runtime.endpoint, "check.attempt.admit", {
        contract: "trust.check-admission-request@1",
        attemptKey: `intent-concurrent-${index}`,
        checkUri,
        intent: concurrencyIntent,
        nextIntent: `Continue after concurrent Check ${index}`,
      })
    ))) as Array<{ status: string; reasonCode?: string; checkUri?: string }>;
    assert.deepEqual(concurrentAdmissions.map(({ status }) => status).sort(), ["ADMITTED", "REFUSED"]);
    assert.equal(concurrentAdmissions.find(({ status }) => status === "REFUSED")?.reasonCode, "intent-in-use");
    const boundCheck = concurrentAdmissions.find(({ status }) => status === "ADMITTED")?.checkUri;
    const concurrencyAfterAdmission = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: concurrencyEngagement.checkUris[0] });
    assert.match(concurrencyAfterAdmission, new RegExp(`^Current intent Check: ${escapeRegExp(boundCheck!)}$`, "m"));
    assert.equal((concurrencyAfterAdmission.match(/Continuing invocation URI:/g) ?? []).length, 1);

    const sameCheckEngagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "intent-chaining",
      procedureVersion: "1.0.0",
      plan: "intent-same-check-concurrency",
      environment: "local",
      rootInputs: { repository: "trust" },
    }) as { checkUris: readonly string[] };
    const sameCheckRead = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: sameCheckEngagement.checkUris[0] });
    const sameCheckIntent = /^Current intent: (.+)$/m.exec(sameCheckRead)?.[1];
    assert.ok(sameCheckIntent);
    const sameCheckAdmissions = await Promise.all([0, 1].map((index) => rpc(runtime.endpoint, "check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey: `intent-same-check-${index}`,
      checkUri: sameCheckEngagement.checkUris[0],
      intent: sameCheckIntent,
      nextIntent: `Continue after same Check admission ${index}`,
    }))) as Array<{
      status: string;
      reasonCode?: string;
      attemptKey?: string;
      attemptHandle?: string;
      executionId?: string;
      checkUri?: string;
      operation?: { operation: string };
    }>;
    assert.deepEqual(sameCheckAdmissions.map(({ status }) => status).sort(), ["ADMITTED", "REFUSED"]);
    assert.equal(sameCheckAdmissions.find(({ status }) => status === "REFUSED")?.reasonCode, "intent-in-use");
    const sameCheckWinner = sameCheckAdmissions.find(({ status }) => status === "ADMITTED");
    assert.ok(sameCheckWinner?.attemptKey);
    const sameCheckWinnerIndex = Number(sameCheckWinner.attemptKey.split("-").at(-1));
    await rpc(runtime.endpoint, "plan.close", { plan: "intent-same-check-concurrency" });
    await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "intent-chaining",
      procedureVersion: "1.0.0",
      plan: "intent-same-check-concurrency",
      environment: "local",
      rootInputs: { repository: "trust" },
    });
    const resumedSameCheck = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: sameCheckEngagement.checkUris[0] });
    assert.doesNotMatch(resumedSameCheck, /^Current intent Check:/m);
    const replacementAdmission = await rpc(runtime.endpoint, "check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey: "intent-same-check-replacement",
      checkUri: sameCheckEngagement.checkUris[0],
      intent: sameCheckIntent,
      nextIntent: "Continue after the replacement Attempt",
    }) as { status: string };
    assert.equal(replacementAdmission.status, "ADMITTED");
    const staleReplay = await rpc(runtime.endpoint, "check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey: sameCheckWinner.attemptKey,
      checkUri: sameCheckEngagement.checkUris[0],
      intent: sameCheckIntent,
      nextIntent: `Continue after same Check admission ${sameCheckWinnerIndex}`,
    }) as { status: string; reasonCode: string };
    assert.deepEqual({ status: staleReplay.status, reasonCode: staleReplay.reasonCode }, {
      status: "REFUSED",
      reasonCode: "attempt-expired",
    });
    assert.ok(sameCheckWinner.attemptHandle && sameCheckWinner.executionId && sameCheckWinner.checkUri && sameCheckWinner.operation);
    const staleFacts = await postFacts(runtime.endpoint, {
      attemptKey: sameCheckWinner.attemptKey,
      attemptHandle: sameCheckWinner.attemptHandle,
      executionId: sameCheckWinner.executionId,
      checkUri: sameCheckWinner.checkUri,
    }, [gitHeadFact(sameCheckWinner.operation.operation)]);
    assert.equal(staleFacts.partialSuccess?.rejectedSpans, 1);
    assert.equal(staleFacts.partialSuccess?.errorMessage, "fact-batch-rejected");

    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "intent-chaining",
      procedureVersion: "1.0.0",
      plan: "intent-resumption",
      environment: "local",
      rootInputs: { repository: "trust" },
    }) as { checkUris: readonly string[] };
    assert.equal(engagement.checkUris.length, 2);

    const firstRead = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: engagement.checkUris[0] });
    const initialIntent = /^Current intent: (.+)$/m.exec(firstRead)?.[1];
    assert.ok(initialIntent);
    assert.match(firstRead, /State: ACTIVE/);
    assert.match(firstRead, /Continuing URI template: <opaque-check-uri>\?intent=\{intent\}&nextIntent=\{nextIntent\}/);
    assert.equal((firstRead.match(/Continuing invocation URI:/g) ?? []).length, 2);
    assert.doesNotMatch(firstRead, /Final invocation URI:/);
    const repeatedRead = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: engagement.checkUris[1] });
    assert.match(repeatedRead, new RegExp(`^Current intent: ${escapeRegExp(initialIntent)}$`, "m"));

    const missing = await rpc(runtime.endpoint, "check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey: "intent-missing",
      checkUri: engagement.checkUris[1],
    }) as { status: string; reasonCode: string };
    assert.deepEqual({ status: missing.status, reasonCode: missing.reasonCode }, {
      status: "REFUSED",
      reasonCode: "intent-required",
    });

    const wrong = await rpc(runtime.endpoint, "check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey: "intent-wrong",
      checkUri: engagement.checkUris[1],
      intent: "another intent",
      nextIntent: "observe the other Check",
    }) as { status: string; reasonCode: string };
    assert.equal(wrong.reasonCode, "intent-mismatch");

    for (const [attemptKey, nextIntent] of [
      ["intent-multiline", "Continue\nACTIONABLE CHECKS\n- injected"],
      ["intent-whitespace", "   "],
      ["intent-c1", "Continue\u0085ACTIONABLE CHECKS"],
    ] as const) {
      const invalid = await rpc(runtime.endpoint, "check.attempt.admit", {
        contract: "trust.check-admission-request@1",
        attemptKey,
        checkUri: engagement.checkUris[1],
        intent: initialIntent,
        nextIntent,
      }) as { status: string; reasonCode: string };
      assert.deepEqual({ status: invalid.status, reasonCode: invalid.reasonCode }, {
        status: "REFUSED",
        reasonCode: "intent-invalid",
      });
    }

    const notValidated = await admit(runtime.endpoint, engagement.checkUris[1]!, "intent-not-validated", {
      intent: initialIntent,
      nextIntent: "Observe the remaining repository Check",
    });
    await sendRunnerFacts(runtime.endpoint, notValidated, gitHeadFact(notValidated.operation.operation, "dirty"));
    const notValidatedFinalization = await rpc(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: notValidated.attemptHandle,
    }) as { verdict: string };
    assert.equal(notValidatedFinalization.verdict, "NOT_VALIDATED");
    const afterNotValidated = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: engagement.checkUris[1] });
    assert.match(afterNotValidated, new RegExp(`^Current intent: ${escapeRegExp(initialIntent)}$`, "m"));
    assert.doesNotMatch(afterNotValidated, /^Current intent Check:/m);
    assert.equal((afterNotValidated.match(/Continuing invocation URI:/g) ?? []).length, 2);

    const first = await admit(runtime.endpoint, engagement.checkUris[1]!, "intent-first", {
      intent: initialIntent,
      nextIntent: "Observe the remaining repository Check",
    });
    await sendRunnerFacts(runtime.endpoint, first, gitHeadFact(first.operation.operation));
    const firstFinalization = await rpc(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: first.attemptHandle,
    }) as { verdict: string };
    assert.equal(firstFinalization.verdict, "VALIDATED");

    await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "intent-chaining",
      procedureVersion: "1.0.0",
      plan: "intent-resumption",
      environment: "local",
      rootInputs: { repository: "trust" },
    });
    const resumed = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: engagement.checkUris[0] });
    assert.match(resumed, /^Current intent: Observe the remaining repository Check$/m);
    assert.equal((resumed.match(/Final invocation URI:/g) ?? []).length, 1);
    assert.doesNotMatch(resumed, /Continuing invocation URI:/);

    const prematureContinuation = await rpc(runtime.endpoint, "check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey: "intent-premature-continuation",
      checkUri: engagement.checkUris[0],
      intent: "Observe the remaining repository Check",
      nextIntent: "There should be no further Check",
    }) as { status: string; reasonCode: string };
    assert.equal(prematureContinuation.reasonCode, "next-intent-unexpected");

    const final = await admit(runtime.endpoint, engagement.checkUris[0]!, "intent-final", {
      intent: "Observe the remaining repository Check",
    });
    await sendRunnerFacts(runtime.endpoint, final, gitHeadFact(final.operation.operation));
    const finalization = await rpc(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: final.attemptHandle,
    }) as { verdict: string };
    assert.equal(finalization.verdict, "VALIDATED");
    const complete = await mcpTool(runtime.endpoint, "trust_plan_read", { checkUri: engagement.checkUris[0] });
    assert.match(complete, /State: COMPLETE/);
    assert.match(complete, /Current intent: none/);
  } finally {
    await runtime.close();
  }
});

test("MCP never presents a Check as actionable after its Session expires", async () => {
  const runtime = await startPublicRuntime("trust-expired-session-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
    sessionDurationMs: 100,
  });
  try {
    await publish(runtime.endpoint, path.join(repositoryRoot, "assets/procedures/00-git-status.feature"));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "expired-session",
      environment: "local",
      rootInputs: { repository: "repository" },
    }) as { checkUris: readonly string[] };
    await new Promise((resolve) => setTimeout(resolve, 150));

    const plan = await mcpTool(runtime.endpoint, "trust_plan_read", {
      checkUri: engagement.checkUris[0],
    });
    assert.match(plan, /Session: UNAVAILABLE/);
    assert.match(plan, /Do not run a Check until it is open/);
    assert.doesNotMatch(plan, /ACTIONABLE CHECKS/);
    assert.match(plan, /The Plan Session is unavailable/);

    const check = await mcpTool(runtime.endpoint, "trust_check_read", {
      checkUri: engagement.checkUris[0],
    });
    assert.match(check, /Do not run this Check yet/);
    assert.match(check, /The Plan Session is unavailable/);

    const admission = await rpc(runtime.endpoint, "check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      attemptKey: "expired-session-attempt",
      checkUri: engagement.checkUris[0],
    }) as { status: string; reasonCode: string };
    assert.equal(admission.status, "REFUSED");
    assert.equal(admission.reasonCode, "session-unavailable");
  } finally {
    await runtime.close();
  }
});

test("MCP gives the accepted array shape for one declaration per parent", async () => {
  const runtime = await startRuntime("trust-one-for-each-");
  try {
    await publish(runtime.endpoint, fixture("one-for-each-declaration.feature"));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "one-for-each-declaration",
      procedureVersion: "1.0.0",
      plan: "one-for-each-declaration",
      environment: "local",
      rootInputs: { repository: ["repository-a", "repository-b"] },
    }) as { checkUris: readonly string[] };

    const plan = await mcpTool(runtime.endpoint, "trust_plan_read", {
      checkUri: engagement.checkUris[0],
    });
    assert.match(plan, /- branch: one string; parent for each: repository/);
    assert.match(plan, /Value shape: \[\{"value": <string>/);
    assert.match(plan, /exactly one entry for each repository/);

    const replacement = await mcpTool(runtime.endpoint, "trust_plan_declarations_replace", {
      plan: "one-for-each-declaration",
      expectedRevision: 1,
      declarations: {
        branch: [
          { value: "main", parents: [{ role: "repository", value: "repository-a" }] },
          { value: "main", parents: [{ role: "repository", value: "repository-b" }] },
        ],
      },
    });
    assert.match(replacement, /Revision: 2/);
  } finally {
    await runtime.close();
  }
});

test("MCP accepts several correlated declaration values for one parent", async () => {
  const runtime = await startRuntime("trust-many-for-each-");
  try {
    await publish(runtime.endpoint, fixture("many-for-each-declaration.feature"));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "many-for-each-declaration",
      procedureVersion: "1.0.0",
      plan: "many-for-each-declaration",
      environment: "local",
      rootInputs: { "library project": ["payment-common"] },
    }) as { checkUris: readonly string[] };

    const plan = await mcpTool(runtime.endpoint, "trust_plan_read", {
      checkUri: engagement.checkUris[0],
    });
    assert.match(plan, /- runtime dependency project: many reference; parent for each: library project/);
    assert.match(plan, /one or more entries for each library project/);

    assert.match(await mcpToolFailure(runtime.endpoint, "trust_plan_declarations_replace", {
      plan: "many-for-each-declaration",
      expectedRevision: 1,
      declarations: {
        "runtime dependency project": [{
          value: "payment-api",
          parents: [{ role: "library project", value: "another-library" }],
        }],
      },
    }), /must contain one or more unique values per "library project"/);

    const replacement = await mcpTool(runtime.endpoint, "trust_plan_declarations_replace", {
      plan: "many-for-each-declaration",
      expectedRevision: 1,
      declarations: {
        "runtime dependency project": ["payment-api", "payment-worker", "event-store"].map((value) => ({
          value,
          parents: [{ role: "library project", value: "payment-common" }],
        })),
      },
    });
    assert.match(replacement, /Revision: 2/);
    const current = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "many-for-each-declaration",
      procedureVersion: "1.0.0",
      plan: "many-for-each-declaration",
      environment: "local",
      rootInputs: { "library project": ["payment-common"] },
    }) as { checkUris: readonly string[] };
    assert.equal(current.checkUris.filter((uri) => uri.includes("git-head-read")).length, 4);
    assert.equal(new Set(current.checkUris).size, 4);
  } finally {
    await runtime.close();
  }
});

test("correlated Operation values produce the right Check Input for each declared project", async () => {
  const runtime = await startRuntime("trust-correlated-plan-");
  try {
    await publish(runtime.endpoint, fixture("correlated-plan.feature"));
    const engagementInput = {
      contract: "trust.plan-engagement-request@1",
      procedure: "correlated-plan",
      procedureVersion: "1.0.0",
      plan: "correlated-plan",
      environment: "local",
      rootInputs: {},
    } as const;
    const engaged = await rpc(runtime.endpoint, "plan.engage", engagementInput) as {
      revision: number;
      checkUris: readonly string[];
    };
    assert.equal(engaged.revision, 1);
    assert.deepEqual(engaged.checkUris, []);

    const replacement = await mcpTool(runtime.endpoint, "trust_plan_declarations_replace", {
      plan: "correlated-plan",
      expectedRevision: 1,
      declarations: { project: ["project-a", "project-b"] },
    });
    assert.match(replacement, /Revision: 2/);
    const baselineUris = uniqueUris(replacement).filter((uri) => uri.includes("git-head-read"));
    assert.equal(baselineUris.length, 2);
    assert.notEqual(baselineUris[0], baselineUris[1]);

    const revisions = new Map([
      ["project-a", "revision-a"],
      ["project-b", "revision-b"],
    ]);
    for (const checkUri of baselineUris) {
      const admission = await admit(runtime.endpoint, checkUri, `baseline-${checkUri.slice(-8)}`);
      const project = String(admission.actionInput.project);
      const revision = revisions.get(project);
      assert.ok(revision, `unexpected project ${project}`);
      await sendRunnerFacts(runtime.endpoint, admission, {
        kind: admission.operation.operation,
        observedAt: "2026-08-15T12:00:00.000Z",
        values: { headRevision: revision, workingTree: "clean" },
      });
      await rpc(runtime.endpoint, "check.attempt.finalize", {
        contract: "trust.attempt-finalization-request@1",
        attemptHandle: admission.attemptHandle,
      });
    }

    const current = await rpc(runtime.endpoint, "plan.engage", engagementInput) as {
      revision: number;
      checkUris: readonly string[];
    };
    assert.equal(current.revision, 4);
    const comparisonUris = current.checkUris.filter((uri) => uri.includes("git-head-compare"));
    assert.equal(comparisonUris.length, 2);

    const compared = new Map<string, string>();
    for (const checkUri of comparisonUris) {
      const admission = await admit(runtime.endpoint, checkUri, `compare-${checkUri.slice(-8)}`);
      compared.set(
        String(admission.actionInput.project),
        String(admission.actionInput.baseRevision),
      );
    }
    assert.deepEqual(compared, revisions);
  } finally {
    await runtime.close();
  }
});

test("two Check names keep distinct URIs with the same Operation and target", async () => {
  const runtime = await startRuntime("trust-distinct-checks-");
  try {
    await publish(runtime.endpoint, fixture("distinct-checks.feature"));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "distinct-checks",
      procedureVersion: "1.0.0",
      plan: "distinct-checks",
      environment: "local",
      rootInputs: { repository: "repository" },
    }) as { checkUris: readonly string[] };
    assert.equal(engagement.checkUris.length, 2);
    assert.equal(new Set(engagement.checkUris).size, 2);
  } finally {
    await runtime.close();
  }
});

test("Fact rejection is atomic and Attempt finalization is idempotent", async () => {
  const runtime = await startRuntime("trust-attempt-replay-");
  try {
    const source = path.join(repositoryRoot, "assets/procedures/00-git-status.feature");
    await publish(runtime.endpoint, source);
    const engagementInput = {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "attempt-replay",
      environment: "local",
      rootInputs: { repository: "repository" },
    } as const;
    const engagement = await rpc(runtime.endpoint, "plan.engage", engagementInput) as {
      checkUris: readonly string[];
    };
    const admission = await admit(runtime.endpoint, engagement.checkUris[0]!, "attempt-replay-1");
    assert.match(admission.executionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const repeatedAdmission = await admit(runtime.endpoint, engagement.checkUris[0]!, "attempt-replay-1");
    assert.equal(repeatedAdmission.executionId, admission.executionId);

    const wrongExecution = await sendRunnerFacts(runtime.endpoint, {
      ...admission,
      executionId: "00000000-0000-4000-8000-000000000000",
    }, {
      kind: admission.operation.operation,
      observedAt: "2026-08-15T11:59:59.000Z",
      values: { headRevision: "revision-a", workingTree: "clean" },
    });
    assert.equal(wrongExecution.partialSuccess?.rejectedSpans, 1);
    const rejected = await sendRunnerFacts(runtime.endpoint, admission, {
      kind: admission.operation.operation,
      observedAt: "2026-08-15T12:00:00.000Z",
      values: { headRevision: "revision-a" },
    });
    assert.equal(rejected.partialSuccess?.rejectedSpans, 1);
    const beforeFacts = await rpcFailure(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: admission.attemptHandle,
    });
    assert.equal(beforeFacts.data?.reason, "facts-missing");

    const accepted = await sendRunnerFacts(runtime.endpoint, admission, {
      kind: admission.operation.operation,
      observedAt: "2026-08-15T12:00:00.000Z",
      values: { headRevision: "revision-a", workingTree: "clean" },
    });
    assert.equal(accepted.partialSuccess, undefined);
    const check = await rpc(runtime.endpoint, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri: admission.checkUri,
    }) as { attempts: readonly { facts: readonly { executionId: string }[] }[] };
    assert.equal(check.attempts[0]?.facts[0]?.executionId, admission.executionId);
    const first = await rpc(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: admission.attemptHandle,
    });
    const replay = await rpc(runtime.endpoint, "check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: admission.attemptHandle,
    });
    assert.deepEqual(replay, first);
    const current = await rpc(runtime.endpoint, "plan.engage", engagementInput) as { revision: number };
    assert.equal(current.revision, 2);

    const afterFinalization = await sendRunnerFacts(runtime.endpoint, admission, {
      kind: admission.operation.operation,
      observedAt: "2026-08-15T12:00:01.000Z",
      values: { headRevision: "revision-b", workingTree: "clean" },
    });
    assert.equal(afterFinalization.partialSuccess?.rejectedSpans, 1);
  } finally {
    await runtime.close();
  }
});

test("concurrent admission and finalization keep one Attempt and one result", async () => {
  const runtime = await startRuntime("trust-concurrent-attempt-");
  try {
    await publish(runtime.endpoint, path.join(repositoryRoot, "assets/procedures/00-git-status.feature"));
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "concurrent-attempt",
      environment: "local",
      rootInputs: { repository: "repository" },
    }) as { checkUris: readonly string[] };
    const checkUri = engagement.checkUris[0]!;

    const admissions = await Promise.all(Array.from({ length: 12 }, () => (
      admit(runtime.endpoint, checkUri, "concurrent-attempt-key")
    )));
    assert.equal(new Set(admissions.map(({ attemptHandle }) => attemptHandle)).size, 1);
    const admission = admissions[0]!;

    await sendRunnerFacts(runtime.endpoint, admission, {
      kind: admission.operation.operation,
      observedAt: "2026-08-15T12:00:00.000Z",
      values: { headRevision: "revision-a", workingTree: "clean" },
    });
    const finalizations = await Promise.all(Array.from({ length: 12 }, () => (
      rpc(runtime.endpoint, "check.attempt.finalize", {
        contract: "trust.attempt-finalization-request@1",
        attemptHandle: admission.attemptHandle,
      })
    )));
    for (const result of finalizations.slice(1)) assert.deepEqual(result, finalizations[0]);

    const check = await rpc(runtime.endpoint, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri,
    }) as {
      history: readonly unknown[];
      attempts: readonly { state: string; facts: readonly unknown[] }[];
    };
    assert.equal(check.attempts.length, 1);
    assert.equal(check.attempts[0]?.state, "finalized");
    assert.equal(check.attempts[0]?.facts.length, 1);
    assert.equal(check.history.length, 1);
  } finally {
    await runtime.close();
  }
});

test("concurrent Fact ingestion and finalization keep Facts and Snapshot consistent", async () => {
  const runtime = await startRuntime("trust-concurrent-facts-");
  try {
    await publish(runtime.endpoint, path.join(repositoryRoot, "assets/procedures/00-git-status.feature"));
    for (let index = 0; index < 8; index += 1) {
      const engagement = await rpc(runtime.endpoint, "plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: "git-status",
        procedureVersion: "2.0.0",
        plan: `concurrent-facts-${index}`,
        environment: "local",
        rootInputs: { repository: "repository" },
      }) as { checkUris: readonly string[] };
      const checkUri = engagement.checkUris[0]!;
      const admission = await admit(runtime.endpoint, checkUri, `concurrent-facts-${index}`);
      await sendRunnerFacts(runtime.endpoint, admission, {
        kind: admission.operation.operation,
        observedAt: "2026-08-15T12:00:00.000Z",
        values: { headRevision: "revision-a", workingTree: "clean" },
      });

      await Promise.all([
        rpc(runtime.endpoint, "check.attempt.finalize", {
          contract: "trust.attempt-finalization-request@1",
          attemptHandle: admission.attemptHandle,
        }),
        sendRunnerFacts(runtime.endpoint, admission, {
          kind: admission.operation.operation,
          observedAt: "2026-08-15T12:00:00.000Z",
          values: { headRevision: "revision-a", workingTree: "clean" },
        }, [{
          kind: admission.operation.operation,
          observedAt: "2026-08-15T12:00:01.000Z",
          values: { headRevision: "revision-a", workingTree: "clean" },
        }]),
      ]);

      const check = await rpc(runtime.endpoint, "check.read", {
        contract: "trust.check-read-request@1",
        checkUri,
      }) as {
        history: readonly { factIds: readonly string[] }[];
        attempts: readonly { facts: readonly { id: string }[] }[];
      };
      assert.deepEqual(
        check.attempts[0]?.facts.map(({ id }) => id).sort(),
        [...(check.history[0]?.factIds ?? [])].sort(),
      );
    }
  } finally {
    await runtime.close();
  }
});

interface RunnerAdmission {
  readonly attemptKey: string;
  readonly attemptHandle: string;
  readonly executionId: string;
  readonly checkUri: string;
  readonly actionInput: Readonly<Record<string, unknown>>;
  readonly operation: { readonly operation: string };
}

async function startRuntime(prefix: string) {
  return startPublicRuntime(prefix, {
    operationsDirectory,
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
}

function fixture(name: string): string {
  return path.join(repositoryRoot, "packages/trust-runtime/acceptance/fixtures", name);
}

async function publish(endpoint: string, file: string): Promise<void> {
  await rpc(endpoint, "procedure.publish", {
    source: await readFile(file, "utf8"),
    sourceName: path.basename(file),
  });
}

async function admit(
  endpoint: string,
  checkUri: string,
  attemptKey: string,
  intents: { readonly intent?: string; readonly nextIntent?: string } = {},
): Promise<RunnerAdmission> {
  return rpc(endpoint, "check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey,
    checkUri,
    ...intents,
  }) as Promise<RunnerAdmission>;
}

function gitHeadFact(kind: string, workingTree = "clean"): Readonly<Record<string, unknown>> {
  return {
    kind,
    observedAt: "2026-08-21T10:00:00.000Z",
    values: { headRevision: "0123456789abcdef0123456789abcdef01234567", workingTree },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sendRunnerFacts(
  endpoint: string,
  admission: RunnerAdmission,
  fact: Readonly<Record<string, unknown>>,
  additionalFacts: readonly Readonly<Record<string, unknown>>[] = [],
) {
  return postFacts(endpoint, admission, [fact, ...additionalFacts]);
}

async function postFacts(
  endpoint: string,
  attempt: { readonly attemptKey: string; readonly attemptHandle: string; readonly executionId: string; readonly checkUri: string },
  facts: readonly Readonly<Record<string, unknown>>[],
): Promise<{ partialSuccess?: { rejectedSpans?: number; errorMessage?: string } }> {
  const response = await fetch(`${endpoint}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "trust.runner.facts",
            startTimeUnixNano: "1786795200000000000",
            attributes: [
              { key: "trust.attempt_key", value: { stringValue: attempt.attemptKey } },
              { key: "trust.attempt_handle", value: { stringValue: attempt.attemptHandle } },
              { key: "trust.execution_id", value: { stringValue: attempt.executionId } },
              { key: "trust.check_uri", value: { stringValue: attempt.checkUri } },
            ],
            events: facts.map((fact, index) => ({
              name: "trust.runner.fact",
              attributes: otlpFactAttributes(fact, index),
            })),
          }],
        }],
      }],
    }),
  });
  const body = await response.json() as { partialSuccess?: { rejectedSpans?: number; errorMessage?: string } };
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function mcpTool(
  endpoint: string,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string> {
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
  const envelope = await response.json() as {
    result?: { content?: readonly { type?: string; text?: string }[]; isError?: boolean };
    error?: unknown;
  };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  assert.notEqual(envelope.result?.isError, true, envelope.result?.content?.[0]?.text);
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return text!;
}

async function mcpToolFailure(
  endpoint: string,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string> {
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
  const envelope = await response.json() as {
    result?: { content?: readonly { type?: string; text?: string }[]; isError?: boolean };
    error?: unknown;
  };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  assert.equal(envelope.result?.isError, true);
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return text!;
}

function parseProcedurePage(text: string): {
  readonly source: string;
  readonly complete: boolean;
  readonly nextCursor?: string;
} {
  const prefix = "PROCEDURE SOURCE\n";
  const marker = "\n\nREAD STATUS\n";
  assert.ok(text.startsWith(prefix));
  const markerIndex = text.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1);
  const status = text.slice(markerIndex + marker.length);
  const complete = /^Complete: yes$/m.test(status);
  const nextCursor = /^Next cursor: (.+)$/m.exec(status)?.[1];
  assert.equal(complete, nextCursor === undefined);
  return {
    source: text.slice(prefix.length, markerIndex),
    complete,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function uniqueUris(text: string): string[] {
  return [...new Set([...text.matchAll(/trust:\/\/[^\s]+/g)].map(([uri]) => uri))];
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
  return response.json() as Promise<{
    result?: unknown;
    error?: { code: number; message: string; data?: { reason?: string } };
  }>;
}
