import { expect, test } from "@playwright/test";
import { runtimeRpc } from "./support/runtime.js";

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
  const runEnvironment = page.getByRole("button", { name: "Environment", exact: true });
  await runEnvironment.click();
  await page.getByRole("option", { name: new RegExp(`^${other}`) }).click();
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(runEnvironment).toContainText(other);
  await expect(switcher).toContainText(first);
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
  await expect(
    page.getByText(`Not runnable on the current environment ${current}: missing aircraftUrl.`),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open the environment" }).click();
  await expect(page).toHaveURL(new RegExp(`/environments/${current}`));
});

test("environment drafts preserve row identity and discard values when the resource changes", async ({
  page,
  request,
}) => {
  await runtimeRpc(request, "environment.save", { environment: "draft-a", values: { first: "one", second: "two" } });
  await runtimeRpc(request, "environment.save", { environment: "draft-b", values: { other: "three" } });
  await page.goto("/environments/draft-a");
  const values = page.locator('[data-doc="environment.values"]');
  const names = values.getByRole("textbox", { name: "Value name", exact: true });
  await expect(names).toHaveCount(2);
  await names.nth(1).fill("renamed");
  await expect(names.nth(1)).toBeFocused();
  await values.getByRole("textbox", { name: "Value", exact: true }).nth(1).fill("unsaved");
  await values.getByRole("button", { name: "Remove value", exact: true }).first().click();
  await expect(names).toHaveCount(1);
  await expect(names.first()).toHaveValue("renamed");
  await expect(values.getByRole("textbox", { name: "Value", exact: true })).toHaveValue("unsaved");
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(values.getByRole("textbox", { name: "Value", exact: true })).toHaveValue("unsaved");
  await page.getByRole("textbox", { name: "Credential name", exact: true }).fill("acceptanceToken");
  await page.getByLabel("Credential value", { exact: true }).fill("acceptance-only-value");
  await page.getByRole("button", { name: "Add credential", exact: true }).click();
  await expect(page.getByRole("button", { name: /Remove.*acceptanceToken/ })).toBeVisible();
  // Credential refresh rebuilds the resource rows; it must not overwrite the values draft.
  await expect(values.getByRole("textbox", { name: "Value", exact: true })).toHaveValue("unsaved");
  await page.getByRole("button", { name: "Expand Environments", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "Navigation" });
  await sidebar.getByRole("link", { name: /draft-b/ }).click();
  await expect(names.first()).toHaveValue("other");
  await page.goBack();
  await expect(names).toHaveCount(2);
  await expect(names.nth(1)).toHaveValue("second");
  await expect(values.getByRole("textbox", { name: "Value", exact: true }).nth(1)).toHaveValue("two");
});
