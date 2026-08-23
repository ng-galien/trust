import { expect, test } from "@playwright/test";

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
  await expect(page.getByRole("button", { name: "Close the Check details" })).toBeVisible();

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

test("the Plan source identifies an omitted optional declaration without inventing a parent wait", async ({ page, request }) => {
  const source = `# language: en
@trust-dsl:1 @procedure:optional-ui-declaration @version:1.0.0
Feature: Show an optional agent declaration

  Background: Plan context
    Given one reference "workspace"
    And one reference "optional project" declared optionally by agent

  @scenario:workspace
  Scenario: Read the workspace
    Then Check "workspace head" runs Operation "git.head-read"
        on "workspace" as Input "project"
        and must establish "the workspace head is readable"
      """js
      fact.headRevision !== "" ||
      fail("the workspace head is unavailable")
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
  const optionalLine = page.locator(".monaco-editor .view-line").filter({ hasText: "optional project" });
  await expect(optionalLine).toContainText("optional — not declared");
  await expect(optionalLine).not.toContainText("waits for its parent");
});

async function runtimeRpc(
  request: Parameters<Parameters<typeof test>[2]>[0]["request"],
  method: string,
  params: unknown,
): Promise<unknown> {
  const response = await request.post("http://127.0.0.1:4390/rpc", {
    data: { jsonrpc: "2.0", id: method, method, params },
  });
  const payload = await response.json() as { result?: unknown; error?: { message: string } };
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}
