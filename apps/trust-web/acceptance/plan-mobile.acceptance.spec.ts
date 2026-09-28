import { expect, test } from "@playwright/test";

import { runtimeRpc } from "./support/runtime.js";

test("a native Plan remains readable and operable at phone and desktop widths", async ({ page, request }) => {
  test.setTimeout(60_000);
  const plan = "phone-reading-acceptance";
  const title = "Inspect the repository state and preserve the complete qualification context on a phone";
  await runtimeRpc(request, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan,
    environment: "local",
    rootInputs: { repository: "trust" },
    metadata: { title, labels: ["mobile", "public-acceptance"], annotations: {} },
  });

  for (const width of [390, 430, 1360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/plans/${plan}`);
    const dialog = page.getByRole("dialog", { name: plan, exact: true });
    await expect(dialog.locator("h1")).toHaveText(title, { timeout: 20_000 });
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Procedure", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    if (width < 640) {
      expect(await dialog.locator("h1").evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("normal");
    }
    const check = dialog.locator('[data-doc="plan.checklist"] button[aria-expanded]').first();
    await check.click();
    const detail = dialog.locator('[data-doc="plan.checkDetail"]');
    await expect(detail).toBeVisible();
    await detail.scrollIntoViewIfNeeded();
    expect(await detail.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await dialog.getByRole("tab", { name: "History", exact: true }).click();
    await expect(dialog.getByRole("tab", { name: "History", exact: true })).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("tab", { name: "Checklist", exact: true }).click();
    await expect(check).toBeVisible();
  }
});
