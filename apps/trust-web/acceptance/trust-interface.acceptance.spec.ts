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
