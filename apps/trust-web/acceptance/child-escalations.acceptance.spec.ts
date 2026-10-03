import { expect, test } from "@playwright/test";
import type { AttemptFinalizationResult, CheckAttemptAdmissionResult, PlanView } from "@trust/extension-sdk";

const scope = `Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe declared repositories. | Change repository state. |`;
const child = (name: string, procedure: string, role: string) =>
  `Then Invocation "${name}" runs Procedure "${procedure}@${procedure === "git-status" ? "2.0.0" : "1.0.0"}" on "${role}" as Input "repository" and must establish "the child is complete"`;
const wrapper = `@trust-dsl:1 @procedure:escalation-wrapper @version:1.0.0
Feature: Nested observation
  Background: Plan context
    ${scope}
    And one reference "repository"
  @scenario:child
  Scenario: Observe nested repository
    ${child("nested", "git-status", "repository")}
`;
const parent = `@trust-dsl:1 @procedure:escalation-root @version:1.0.0
Feature: Root escalation oversight
  Background: Plan context
    ${scope}
    And one reference "repository" declared by agent
    And one reference "stable"
  @scenario:children
  Scenario: Observe children
    ${child("changing", "escalation-wrapper", "repository")}
    ${child("stable", "git-status", "stable")}
  @scenario:independent
  Scenario: Independent parent observation
    Then Check "parent observation" runs Operation "git.head-read@*" on "stable" as Input "project" and must establish "the repository is dirty"
      """js
      fact.workingTree === "dirty" || fail("The repository is clean")
      """
`;

test("root shows all current descendant escalations, navigates to origin and refreshes after resume and replacement", async ({
  page,
  request,
}) => {
  const rpc = async <T = unknown>(method: string, params: unknown): Promise<T> => {
    const response = await request.post("http://127.0.0.1:4397/rpc", {
      data: { jsonrpc: "2.0", id: method, method, params },
    });
    const envelope = await response.json();
    expect(envelope.error).toBeUndefined();
    return envelope.result as T;
  };
  const read = (plan: string) => rpc<PlanView>("plan.read", { plan });
  /** A value the scenario requires: absence fails the test with its reason. */
  const present = <T>(value: T | null | undefined, what: string): T => {
    if (value === null || value === undefined) throw new Error(`Missing ${what}`);
    return value;
  };
  const childOf = (view: PlanView, name: string) =>
    present(view.invocations.find((value) => value.name === name)?.childPlan, `child Plan ${name}`);
  let sequence = 0;
  const escalate = async (plan: string, reason: string) => {
    const view = await read(plan);
    const admission = await rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: present(view.checks[0], "first Check").checkUri,
      attemptKey: `browser-escalation-${++sequence}`,
    });
    if (admission.status !== "ADMITTED") throw new Error(`Admission refused: ${admission.reason}`);
    const now = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptKey: admission.attemptKey,
      attemptHandle: admission.attemptHandle,
      executionId: admission.executionId,
      checkUri: admission.checkUri,
      recordedAt: now,
      facts: [
        {
          kind: admission.operation.operation,
          observedAt: now,
          values: { headRevision: `browser-${sequence}`, workingTree: "clean" },
        },
      ],
    });
    expect(
      (
        await rpc<AttemptFinalizationResult>("check.attempt.finalize", {
          contract: "trust.attempt-finalization-request@1",
          attemptHandle: admission.attemptHandle,
        })
      ).verdict,
    ).toBe("NOT_VALIDATED");
    await rpc("check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: admission.checkUri,
      attemptHandle: admission.attemptHandle,
      blockingReason: reason,
      forbiddenFurtherAction: "Do not modify the repository to bypass qualification.",
    });
  };
  await rpc("procedure.publish", { source: wrapper });
  await rpc("procedure.publish", { source: parent });
  await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "escalation-root",
    procedureVersion: "1.0.0",
    plan: "other-plan",
    environment: "local",
    mode: "dry-run",
    metadata: { title: "Root escalation oversight" },
    rootInputs: { stable: "trust" },
  });
  await rpc("plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan: "other-plan",
    expectedRevision: (await read("other-plan")).revision,
    declarations: { repository: "trust" },
  });
  const root = await read("other-plan");
  const changing = childOf(root, "changing");
  const stable = childOf(root, "stable");
  const nested = present((await read(changing)).invocations[0]?.childPlan, "nested child Plan");
  expect((await read(changing)).checks).toHaveLength(0);
  expect((await read(changing)).currentIntentCheckUri).toBeNull();
  await page.goto(`/dry-runs/${changing}`);
  const composition = page.getByRole("region", { name: "Child Plans", exact: true });
  await expect(composition.getByRole("link", { name: "Open child Plan: nested", exact: true })).toHaveAttribute(
    "href",
    `/dry-runs/${nested}`,
  );
  await composition.getByRole("link", { name: "Open child Plan: nested", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dry-runs/${nested}$`));
  await page.getByRole("link", { name: `Parent Plan: ${changing}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dry-runs/${changing}$`));
  await page.goto("/dry-runs/other-plan");
  const alerts = page.getByTestId("descendant-escalations");
  await expect(alerts).toHaveCount(0);
  await escalate(nested, "Nested repository needs operator authority.");
  await expect(alerts).toContainText("1 descendant escalation");
  const restart = await request.post("http://127.0.0.1:4398/restart");
  expect(restart.ok()).toBe(true);
  const resumedRoot = await read("other-plan");
  expect(resumedRoot.invocations.map((value) => value.childPlan)).toEqual(
    root.invocations.map((value) => value.childPlan),
  );
  expect((await read(changing)).invocations[0]?.childPlan).toBe(nested);
  await escalate(stable, "Sibling repository needs separate review.");
  await expect(alerts).toContainText("2 descendant escalations");
  await expect(page.getByText("Runtime live", { exact: true })).toBeVisible();
  await expect(alerts.getByRole("listitem")).toHaveCount(2);
  await expect(alerts).toContainText("Nested repository needs operator authority.");
  await expect(alerts).toContainText("Sibling repository needs separate review.");
  expect((await read("other-plan")).workState).toBe("IN_PROGRESS");
  await expect(page.locator('[data-doc="plan.escalation"]')).toHaveCount(0);
  await escalate("other-plan", "The parent has its own independent blocker.");
  await expect(page.locator('[data-doc="plan.escalation"]')).toContainText(
    "The parent has its own independent blocker.",
  );
  await expect(alerts.getByRole("listitem")).toHaveCount(2);
  const own = present((await read("other-plan")).activeEscalation, "own escalation");
  await rpc("plan.resume", {
    plan: "other-plan",
    escalationId: own.escalationId,
    resumeReason: "Parent authority reviewed independently.",
  });
  await expect(page.locator('[data-doc="plan.escalation"]')).toHaveCount(0);
  const originLink = alerts.locator(`a[href^="/dry-runs/${nested}?"]`);
  const href = present(await originLink.getAttribute("href"), "origin link");
  expect(new URL(href, page.url()).searchParams.get("sel")).toBe(
    `check:${present((await read(nested)).activeEscalation, "nested escalation").checkUri}`,
  );
  const originTab = await page.context().newPage();
  await originTab.goto(new URL(href, page.url()).href);
  await expect(originTab.locator('[data-doc="plan.escalation"]')).toContainText(
    "Nested repository needs operator authority.",
  );
  await expect(originTab.locator('[data-doc="plan.checkDetail"]')).toBeVisible();
  await originTab.close();
  await originLink.click();
  await expect(page).toHaveURL(new RegExp(`/dry-runs/${nested}\\?`));
  await expect(page.locator('[data-doc="plan.escalation"]')).toContainText(
    "Nested repository needs operator authority.",
  );
  await expect(page.locator('[data-doc="plan.checkDetail"]')).toBeVisible();
  await page.goBack();
  await expect(alerts).toContainText("2 descendant escalations");
  await page.screenshot({ path: "test-results/child-escalations-root.png" });
  await page.goto("/dry-runs");
  await expect(page.locator('a[data-doc="home.card"][href="/dry-runs/other-plan"]')).toContainText(
    "2 descendant escalations",
  );
  const escalation = present((await read(stable)).activeEscalation, "stable escalation");
  await rpc("plan.resume", {
    plan: stable,
    escalationId: escalation.escalationId,
    resumeReason: "Sibling review completed.",
  });
  await page.goto("/dry-runs/other-plan");
  await expect(alerts).toContainText("1 descendant escalation");
  await rpc("plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan: "other-plan",
    expectedRevision: (await read("other-plan")).revision,
    declarations: { repository: "replacement" },
  });
  await expect(alerts).toHaveCount(0);
  expect((await read(nested)).escalations).toHaveLength(1);
  expect((await read(stable)).escalations[0]?.resumeReason).toBe("Sibling review completed.");
  await page.getByText("Previous generations", { exact: true }).click();
  await page.getByRole("link", { name: "Superseded generation 1", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dry-runs/${changing}$`));
  await expect(page.getByRole("region", { name: "Child Plans", exact: true })).toContainText("Superseded generation 1");
  await page.getByRole("link", { name: "Parent Plan: other-plan", exact: true }).click();
  await expect(alerts).toHaveCount(0);
});
