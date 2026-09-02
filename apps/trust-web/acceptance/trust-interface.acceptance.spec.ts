import { expect, test } from "@playwright/test";

import { runtimeRpc } from "./support/runtime.js";

/* The interface keeps Operations, Procedures, Plans and Checks connected, in operator mode (default) and expert mode. */

test("the interface keeps Operations, Procedures, Plans and Checks connected", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.goto("/procedures/git-status");
  await expect(page.locator("#procedure-title")).toHaveText("Establish whether a Git repository has local changes");
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(page).toHaveURL(/tab=dag/);
  // The operator mode has no Compiled JSON tab; the expert mode has it.
  await expect(page.getByRole("tab", { name: "Compiled JSON" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Expert" }).click();
  await expect(page.getByRole("tab", { name: "Compiled JSON" })).toBeVisible();
  await page.getByRole("tab", { name: "Operator" }).click();

  await page.goto("/plans/interface-acceptance");
  await expect(page.locator("#plan-title")).toHaveText("interface-acceptance");
  await page.getByRole("button", { name: /repository status/ }).first().click();
  await expect(page).toHaveURL(/sel=check/);
  await expect(page.getByRole("region", { name: "Details of repository status" })).toBeVisible();

  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Use light theme" })).toBeVisible();
});

test("the procedure picker does not make the engagement form scroll", async ({ page }) => {
  await page.goto("/dry-runs?q=aircraft");
  await page.getByRole("link", { name: "New dry-run" }).click();
  await expect(page).toHaveURL(/\/dry-runs\/new$/);
  const form = page.locator('[data-doc="engage.form"]');
  const before = await form.evaluate(({ scrollHeight, scrollTop }) => ({ scrollHeight, scrollTop }));

  await page.getByRole("button", { name: "Procedure", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Procedure" })).toBeVisible();
  await expect.poll(() => form.evaluate(({ scrollHeight, scrollTop }) => ({ scrollHeight, scrollTop }))).toEqual(before);

  await page.getByRole("option", { name: /Prepare and release one aircraft/ }).click();
  await expect(page.getByRole("listbox", { name: "Procedure" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Procedure", exact: true })).toContainText("Prepare and release one aircraft");
});

test("the Operation views render the unified HTTP request contract", async ({ page }) => {
  await page.goto("/operations/jira.issue-transition");
  await expect(page.locator("#operation-title")).toHaveText("Transition one Jira issue between two exact workflow statuses");
  const summary = page.locator('[data-doc="operation.summary"]');
  await expect(summary).toContainText(/sends GET to environment\.jiraIssueUrl\/\{input\.issue\}/);
  await expect(summary).toContainText(/sends POST to environment\.jiraIssueUrl\/\{input\.issue\}\/\{literal "transitions"\} and reads no body with JSONata/);

  await page.getByRole("tab", { name: "Expert" }).click();
  await page.getByRole("button", { name: "Steps" }).click();
  await expect(page.getByText("Accepted statuses").first()).toBeVisible();
  await expect(page.getByText("200–299").first()).toBeVisible();
});

test("the Plan keeps an omitted each branch visible and expands it without reloading", async ({ page, request }) => {
  const source = `# language: en
@trust-dsl:1 @procedure:optional-ui-declaration @version:1.0.0
Feature: Show an optional agent declaration

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Perform only the actions declared by this Procedure. | Alter the environment or accepted observations to make a Check pass. |
    Given one reference "workspace"
    And many reference "optional project" declared optionally by agent

  @scenario:workspace
  Scenario: Read the workspace
    Then Check "workspace head" runs Operation "git.head-read"
        on "workspace" as Input "project"
        and must establish "the workspace head is readable"
      """js
      fact.headRevision !== "" ||
      fail("the workspace head is unavailable")
      """

  @scenario:optional-projects
  Scenario: Read every optional project
    Then Check "optional project head" runs Operation "git.head-read"
        on each "optional project" as Input "project"
        and must establish "every optional project head is readable"
      """js
      fact.headRevision !== "" ||
      fail("an optional project head is unavailable")
      """
`;
  await runtimeRpc(request, "procedure.publish", { source, sourceName: "optional-ui-declaration.feature" });
  await runtimeRpc(request, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "optional-ui-declaration",
    procedureVersion: "1.0.0",
    plan: "optional-ui-declaration",
    environment: "local",
    rootInputs: { workspace: "trust" },
  });

  await page.goto("/plans/optional-ui-declaration?tab=source");
  const optionalLine = page.locator(".monaco-editor .view-line").filter({ hasText: 'many reference "optional project"' });
  await expect(optionalLine).toContainText("optional — not declared");
  await expect(optionalLine).not.toContainText("waits for its parent");

  await page.getByRole("tab", { name: "Checklist" }).click();
  await expect(page.getByText("optional project head", { exact: true })).toBeVisible();
  await expect(page.getByText("for each optional project", { exact: true })).toBeVisible();
  await expect(page.getByText("0 instances", { exact: true })).toBeVisible();
  await expect(page.getByText("No instances", { exact: true })).toHaveCount(2);

  await runtimeRpc(request, "plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan: "optional-ui-declaration",
    expectedRevision: 1,
    declarations: { "optional project": ["payment-api"] },
  });
  await expect(page.getByText("1 instance", { exact: true })).toBeVisible();
  const paymentApi = page.getByRole("button", { name: /payment-api/ });
  await expect(paymentApi).toHaveAccessibleName('"payment-api" optional project · git.head-read Next Check');

  await runtimeRpc(request, "plan.declarations.replace", {
    contract: "trust.plan-declaration-replacement-request@1",
    plan: "optional-ui-declaration",
    expectedRevision: 2,
    declarations: { "optional project": ["payment-api", "payment-worker"] },
  });
  await expect(page.getByText("2 instances", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /payment-api/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /payment-worker/ })).toHaveCount(1);
});

test("the operator resumes an escalated Plan from the interface", async ({ page, request }) => {
  const externalImageRequests: string[] = [];
  page.on("request", (browserRequest) => {
    if (browserRequest.url() === "https://example.invalid/escalation.png") externalImageRequests.push(browserRequest.url());
  });
  await runtimeRpc(request, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan: "ui-escalation",
    environment: "local",
    rootInputs: { repository: "trust" },
    mode: "dry-run",
  });
  const plan = await runtimeRpc<{
    actionableChecks: readonly string[];
  }>(request, "plan.read", { plan: "ui-escalation" });
  const admission = await runtimeRpc<{
    attemptKey: string;
    attemptHandle: string;
    executionId: string;
    checkUri: string;
    operation: { operation: string };
  }>(request, "check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey: "ui-escalation-attempt",
    checkUri: plan.actionableChecks[0],
  });
  const observedAt = new Date().toISOString();
  await runtimeRpc(request, "check.attempt.facts", {
    contract: "trust.fact-batch-request@1",
    attemptKey: admission.attemptKey,
    attemptHandle: admission.attemptHandle,
    executionId: admission.executionId,
    checkUri: admission.checkUri,
    recordedAt: observedAt,
    facts: [{
      kind: admission.operation.operation,
      observedAt,
      values: { headRevision: "abc123", workingTree: "clean" },
    }],
  });
  await runtimeRpc(request, "check.attempt.finalize", {
    contract: "trust.attempt-finalization-request@1",
    attemptHandle: admission.attemptHandle,
  });
  await runtimeRpc(request, "check.escalate", {
    contract: "trust.check-escalation-request@1",
    checkUri: admission.checkUri,
    attemptHandle: admission.attemptHandle,
    blockingReason: "The repository does not contain the **expected local change**.\n\n- The worktree is clean.\n- The required change is absent.\n\n![untrusted image](https://example.invalid/escalation.png)",
    forbiddenFurtherAction: "Modify the repository or run `git reset --hard` merely to manufacture the expected status.",
  });

  await page.goto("/dry-runs?state=escalated&view=list");
  await expect(page.getByRole("link", { name: /ui-escalation/ })).toBeVisible();
  await expect(page.getByRole("table").getByText("Escalated", { exact: true })).toBeVisible();

  await page.goto("/procedures/git-status");
  await expect(page.getByRole("link", { name: /ui-escalation/ })).toBeVisible();
  await expect(page.getByText("Escalated", { exact: true })).toBeVisible();

  await page.goto("/dry-runs/ui-escalation");
  await expect(page.getByText("Procedure stopped by escalation")).toBeVisible();
  await expect(page.getByRole("button", { name: /Escalated$/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Blocking reason", exact: true })).toBeVisible();
  await expect(page.getByText("expected local change", { exact: true })).toHaveJSProperty("tagName", "STRONG");
  await expect(page.locator("li").filter({ hasText: "The required change is absent." })).toBeVisible();
  await expect(page.getByText("git reset --hard", { exact: true })).toHaveJSProperty("tagName", "CODE");
  await expect(page.locator("[node]")).toHaveCount(0);
  expect(externalImageRequests).toEqual([]);
  let refuseFirstResume = true;
  let equalizeHistoryTimes = false;
  await page.route("**/rpc", async (route) => {
    const payload = route.request().postDataJSON() as { id?: string; method?: string };
    if (refuseFirstResume && payload.method === "plan.resume") {
      refuseFirstResume = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          error: { code: -32_000, message: "Plan resumption refused", data: { message: "The escalation changed before the Plan could resume." } },
        }),
      });
      return;
    }
    if (equalizeHistoryTimes && payload.method === "plan.read") {
      const response = await route.fetch();
      const body = await response.json() as { result?: { plan?: string; escalations?: Array<{ escalatedAt: string; resumedAt: string | null }> } };
      if (body.result?.plan === "ui-escalation") {
        for (const escalation of body.result.escalations ?? []) {
          escalation.escalatedAt = "2026-08-27T10:00:00.000Z";
          if (escalation.resumedAt !== null) escalation.resumedAt = escalation.escalatedAt;
        }
      }
      await route.fulfill({ response, json: body });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  const resumeDialog = page.getByRole("alertdialog");
  await expect(resumeDialog.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
  await resumeDialog.getByRole("textbox", { name: "Resume reason", exact: true }).fill("The operator reviewed the blocker and authorized another observation within the Procedure scope.");
  await resumeDialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(resumeDialog.getByText("The escalation changed before the Plan could resume.", { exact: true })).toBeVisible();
  await resumeDialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText("Procedure stopped by escalation")).toHaveCount(0);
  await expect.poll(async () => (
    await runtimeRpc<{ workState: string }>(request, "plan.read", { plan: "ui-escalation" })
  ).workState).toBe("IN_PROGRESS");
  equalizeHistoryTimes = true;
  await page.reload();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const escalationHistory = page.getByRole("region", { name: "Escalation history", exact: true });
  await expect(escalationHistory.getByText("Resumed", { exact: true })).toBeVisible();
  await expect(escalationHistory.getByText("The operator reviewed the blocker and authorized another observation within the Procedure scope.", { exact: true })).toBeVisible();
  await expect(escalationHistory.getByText("Escalated", { exact: true })).toBeVisible();
  await expect(escalationHistory.getByText("The repository does not contain the expected local change.", { exact: true })).toBeVisible();
  expect(await escalationHistory.locator(":scope > ol > li").allTextContents()).toEqual([
    expect.stringContaining("Resumed"),
    expect.stringContaining("Escalated"),
  ]);
});
