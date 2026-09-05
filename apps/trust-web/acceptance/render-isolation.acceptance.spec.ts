import { expect, test } from "@playwright/test";

test("a resource render failure preserves navigation and a fresh route can render", async ({ page }) => {
  // Fault injection at the public network boundary: the runtime remains real,
  // while one display-only field is corrupted in the browser's received payload.
  await page.route("**/rpc", async (route) => {
    const request = route.request().postDataJSON();
    const response = await route.fetch();
    if (request.method !== "operation.list") return route.fulfill({ response });
    const payload = await response.json();
    const operation = payload.result.operations.find(
      (entry: { operation: string }) => entry.operation === "coordination.mission-create",
    );
    operation.description = { invalidDisplayValue: true };
    await route.fulfill({ response, json: payload });
  });
  await page.goto("/operations/coordination.mission-create");
  await expect(page.getByRole("alert")).toContainText("This page could not be displayed", { timeout: 30_000 });
  await expect(page.locator('[data-doc="shell.sidebar"]')).toBeVisible();
  await page.getByRole("link", { name: "Back to overview", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole("alert").filter({ hasText: "This page could not be displayed" })).toHaveCount(0);
});
