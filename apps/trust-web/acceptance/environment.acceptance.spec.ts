import { expect, test } from "@playwright/test";

/* The current environment is a global user context: chosen in the header, remembered, never in the URL;
   runs default to it and the interface always says why something cannot run on it. */

test("the header selects the current environment and the run view follows it", async ({ page }) => {
  await page.goto("/operations/git.head-read?tab=run");
  const switcher = page.getByRole("button", { name: "Current environment" });
  await expect(switcher).toHaveText(/^(local|staging)$/);
  const first = (await switcher.textContent())!.trim();
  // The run view proposes the current environment.
  await expect(page.getByRole("button", { name: "Environment", exact: true })).toContainText(first);
  // Pick another environment from the header: the run view follows, the URL does not change.
  const other = first === "local" ? "staging" : "local";
  await switcher.click();
  await page.getByRole("option", { name: new RegExp(`^${other}`) }).click();
  await expect(switcher).toContainText(other);
  await expect(page.getByRole("button", { name: "Environment", exact: true })).toContainText(other);
  await expect(page).toHaveURL(/\/operations\/git\.head-read\?tab=run$/);
  // Remembered across navigations.
  await page.reload();
  await expect(page.getByRole("button", { name: "Current environment" })).toContainText(other);
});

test("an operation the current environment cannot run says which values are missing", async ({ page }) => {
  await page.goto("/operations/aviation.aircraft-read?tab=run");
  const switcher = page.getByRole("button", { name: "Current environment" });
  await expect(switcher).toHaveText(/^(local|staging)$/);
  const current = (await switcher.textContent())!.trim();
  await expect(page.getByText(`Not runnable on the current environment ${current}: missing aircraftUrl.`)).toBeVisible();
  await page.getByRole("link", { name: "Open the environment" }).click();
  await expect(page).toHaveURL(new RegExp(`/environments/${current}`));
});
