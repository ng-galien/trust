import { expect, test } from "@playwright/test";

test("the interface keeps Operations, Procedures, Plans and Checks connected", async ({ page }) => {
  await page.goto("/overview");

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("region", { name: "TRUST resource relationships" })).toContainText("Operations");
  await expect(page.getByRole("region", { name: "TRUST resource relationships" })).toContainText("Procedures");
  await expect(page.getByRole("region", { name: "TRUST resource relationships" })).toContainText("Plans");

  await page.goto("/procedures/git-status");
  await expect(page.getByRole("heading", { name: "Establish whether a Git repository has local changes" })).toBeVisible();
  await page.getByRole("tab", { name: "Compiled DAG" }).click();
  await expect(page.getByLabel("Compiled DAG for Establish whether a Git repository has local changes")).toContainText("repository status");

  await page.goto("/plans/interface-acceptance");
  await expect(page.getByRole("heading", { name: "interface-acceptance" })).toBeVisible();
  await page.getByRole("tab", { name: "Checklist" }).click();
  await page.getByRole("button", { name: /repository status/i }).first().click();
  await expect(page.getByText("Check detail")).toBeVisible();
  await expect(page.getByRole("heading", { name: "repository status" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Attempts (0)" })).toBeVisible();

  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Use light theme" })).toBeVisible();
});
