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
