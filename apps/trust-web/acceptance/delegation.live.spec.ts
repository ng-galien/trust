import { type APIRequestContext, expect, test } from "@playwright/test";
import type { PlanSummaryView, PlanView } from "@trust/extension-sdk";

async function rpc<T>(request: APIRequestContext, method: string, params: unknown): Promise<T> {
  const response = await request.post("/rpc", { data: { jsonrpc: "2.0", id: method, method, params } });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  expect(payload.error).toBeUndefined();
  return payload.result;
}

test("Delegation uses the shared catalog and detail, excludes unrelated Plans and selects work in its inspector", async ({
  page,
  request,
}) => {
  const before = await rpc<{ plans: PlanSummaryView[] }>(request, "plan.list", {});
  const plans = before.plans.filter((p) => p.mode === "live");
  const parents = plans.filter((p) => plans.some((child) => child.parent?.plan === p.plan));
  const parent = parents.find((p) => p.plan === "consolidation-20260909") ?? parents[0];
  if (!parent) throw new Error("Read-only acceptance needs an existing delegation");
  const child = plans.find((p) => p.parent?.plan === parent.plan);
  if (!child) throw new Error("Missing child");
  await page.goto("/delegation?view=list");
  const content = page.locator('[data-doc="home.content"]');
  await expect(content.getByRole("table")).toBeVisible();
  await expect(content.locator("tbody tr")).toHaveCount(parents.length);
  for (const standalone of plans.filter((p) => !parents.includes(p)))
    await expect(
      content.getByRole("link", { name: standalone.metadata.title ?? standalone.plan, exact: true }),
    ).toHaveCount(0);
  await page.getByPlaceholder("Search delegation work…").fill(parent.plan);
  await expect(content.locator("tbody tr")).toHaveCount(1);
  await content.getByRole("link").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("navigation", { name: "Breadcrumb" })).toContainText(parent.plan);
  await expect(
    dialog.getByRole("heading", { name: parent.metadata.title ?? parent.procedure, exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("tablist")).toHaveCount(0);

  const childRow = dialog.locator(`button[data-plan="${child.plan}"]`);
  const view = await rpc<PlanView>(request, "plan.read", { plan: child.plan });
  await expect(childRow).toBeVisible();
  await childRow.click();
  const inspector = dialog.getByRole("article", { name: "Selected Plan" });
  await expect(childRow).toHaveAttribute("aria-current", "true");
  await expect(inspector).toHaveAttribute("data-work-detail", child.plan);
  for (const check of view.checks) {
    await expect(inspector).toContainText(check.successReason);
    await expect(inspector).toContainText(check.reason ?? "No qualification recorded yet.");
  }
  await expect(inspector.getByRole("button", { name: "History", exact: true })).toBeVisible();
  await expect(dialog.locator("table")).toHaveCount(0);
  await expect(inspector.locator('[data-doc="plan.checklist"]')).toBeVisible();
  const disclosure = inspector.locator("button[aria-expanded]").first();
  await expect(disclosure).toBeVisible();
  await expect(inspector).toContainText(view.checks[0]?.operation ?? "");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({
    path: "/tmp/trust-delegation-live-results/selected-work.png",
    fullPage: true,
    animations: "disabled",
  });
  for (const work of plans.filter((p) => p.parent?.plan === parent.plan)) {
    const button = dialog.locator(`button[data-plan="${work.plan}"]`);
    await button.press("Enter");
    await expect(button).toHaveAttribute("aria-current", "true");
    await expect(inspector).toHaveAttribute("data-work-detail", work.plan);
    const workView = await rpc<PlanView>(request, "plan.read", { plan: work.plan });
    for (const check of workView.checks) {
      for (const reason of check.blockedBy) await expect(inspector).toContainText(reason);
    }
  }
  await page.screenshot({
    path: "/tmp/trust-delegation-live-results/selected-last-work.png",
    fullPage: true,
    animations: "disabled",
  });
  const rootView = await rpc<PlanView>(request, "plan.read", { plan: parent.plan });
  if (rootView.checks.length) {
    await dialog.locator(`button[data-plan="${parent.plan}"]`).click();
    await expect(inspector).toHaveAttribute("data-work-detail", parent.plan);
    for (const check of rootView.checks)
      await expect(inspector).toContainText(check.reason ?? "No qualification recorded yet.");
  }
  const historyButton = inspector.getByRole("button", { name: "History", exact: true });
  await historyButton.click();
  await expect(historyButton).toHaveAttribute("aria-pressed", "true");
  await expect(inspector.locator('[data-doc="plan.checklist"]')).toHaveCount(0);
  await historyButton.click();
  await expect(historyButton).toHaveAttribute("aria-pressed", "false");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByPlaceholder("Search delegation work…")).toHaveValue(parent.plan);
  await page.getByPlaceholder("Search delegation work…").fill("");
  await page.getByRole("button", { name: /^Display/ }).click();
  await page.getByRole("tab", { name: "Cards", exact: true }).click();
  await page.getByRole("button", { name: /^Display/ }).click();
  await expect(content.locator('[data-doc="home.card"]')).toHaveCount(parents.length);
  const after = await rpc<{ plans: PlanSummaryView[] }>(request, "plan.list", {});
  expect(after.plans.map((p) => [p.plan, p.revision, p.workState])).toEqual(
    before.plans.map((p) => [p.plan, p.revision, p.workState]),
  );
});

test("Delegation list and detail work at a narrow viewport", async ({ page, request }) => {
  const { plans } = await rpc<{ plans: PlanSummaryView[] }>(request, "plan.list", {});
  const parent = plans.find((p) => p.mode === "live" && plans.some((c) => c.parent?.plan === p.plan));
  if (!parent) throw new Error("Missing delegation");
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto("/delegation?view=list");
  await expect(page.locator('[data-doc="home.content"] table')).toBeVisible();
  await page.goto(`/delegation?view=list&plan=${encodeURIComponent(parent.plan)}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Work", exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Selected Plan" })).toBeVisible();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.getByRole("article", { name: "Selected Plan" })).toBeVisible();
  await page.screenshot({
    path: "/tmp/trust-delegation-live-results/narrow.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
