import { type APIRequestContext, expect, test } from "@playwright/test";
import type { EnvironmentEntry, PlanSummaryView, PlanView } from "@trust/extension-sdk";

async function rpc<T>(request: APIRequestContext, method: string, params: unknown): Promise<T> {
  const response = await request.post("/rpc", { data: { jsonrpc: "2.0", id: method, method, params } });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  expect(payload.error).toBeUndefined();
  return payload.result;
}

test("Delegation shows parent-child work as a navigable tree and selects work in its inspector", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const before = await rpc<{ plans: PlanSummaryView[] }>(request, "plan.list", {});
  const environments = await rpc<{ environments: EnvironmentEntry[] }>(request, "environment.list", {});
  const plans = before.plans.filter((p) => p.mode === "live");
  const parents = plans.filter((p) => plans.some((child) => child.parent?.plan === p.plan));
  const roots = parents.filter((p) => !p.parent || !parents.some((candidate) => candidate.plan === p.parent?.plan));
  const parent = parents.find((p) => p.plan === "consolidation-20260909") ?? parents[0];
  if (!parent) throw new Error("Read-only acceptance needs an existing delegation");
  const child = plans.find((p) => p.parent?.plan === parent.plan);
  if (!child) throw new Error("Missing child");
  await page.goto("/delegation?view=list");
  const content = page.locator('[data-doc="home.content"]');
  const tree = content.getByRole("list", { name: "Delegation tree" });
  await expect(tree.locator(":scope > li")).toHaveCount(roots.length, { timeout: 15_000 });
  await expect(tree).toBeVisible();
  for (const root of roots) {
    const node = tree.locator(`:scope > li[data-delegation-plan="${root.plan}"]`);
    const context = node.locator(":scope > div").last();
    await expect(node.locator(":scope > div").first()).toContainText(root.procedure);
    await expect(context.getByRole("link", { name: `Environment: ${root.environment}` })).toHaveAttribute(
      "href",
      `/environments/${encodeURIComponent(root.environment)}`,
    );
    const workspace = environments.environments.find((entry) => entry.name === root.environment)?.values.workspaceRoot;
    if (workspace) await expect(context).toContainText(workspace);
  }
  for (const standalone of plans.filter((p) => !p.parent && !parents.includes(p)))
    await expect(
      content.getByRole("link", { name: standalone.metadata.title ?? standalone.plan, exact: true }),
    ).toHaveCount(0);
  const parentNode = tree.locator(`[data-delegation-plan="${parent.plan}"]`);
  const childNode = parentNode.locator(`[data-delegation-plan="${child.plan}"]`);
  await expect(childNode).toBeVisible();
  await parentNode
    .locator(":scope > div")
    .getByRole("button", { name: /^Collapse/ })
    .click();
  await expect(childNode).toHaveCount(0);
  await parentNode
    .locator(":scope > div")
    .getByRole("button", { name: /^Expand/ })
    .click();
  await expect(childNode).toBeVisible();
  await page.getByPlaceholder("Search delegation work…").fill(child.plan);
  await expect(tree.locator(":scope > li")).toHaveCount(1);
  await expect(parentNode).toBeVisible();
  await expect(childNode).toBeVisible();
  await page.getByPlaceholder("Search delegation work…").fill(parent.plan);
  await expect(tree.locator(":scope > li")).toHaveCount(1);
  await parentNode.getByRole("link").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
    parent.metadata.title ?? parent.procedure,
  );
  await expect(
    dialog.getByRole("heading", { name: parent.metadata.title ?? parent.procedure, exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("tablist")).toHaveCount(0);

  const childRow = dialog.locator(`button[data-plan="${child.plan}"]`);
  const workTree = dialog.locator("nav.delegation-worklist > ul.delegation-tree");
  const parentWorkNode = workTree.locator(":scope > li");
  await expect(parentWorkNode.locator(`button[data-plan="${parent.plan}"]`)).toBeVisible();
  await expect(parentWorkNode.locator(`ul.delegation-tree-children button[data-plan="${child.plan}"]`)).toBeVisible();
  for (const work of [parent, child]) {
    const state = dialog.locator(`button[data-plan="${work.plan}"] .delegation-workitem-state`);
    await expect(state).toBeVisible();
    await expect(state).toHaveClass(/bg-(info|success|warning)-soft/);
  }
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
  await expect(inspector.getByRole("link", { name: "Open Plan execution", exact: true })).toHaveAttribute(
    "href",
    `/plans/${encodeURIComponent(child.plan)}`,
  );
  await expect(inspector.getByRole("button", { name: "History", exact: true })).toBeVisible();
  await expect(dialog.locator("table")).toHaveCount(0);
  await expect(inspector.locator('[data-doc="plan.checklist"]')).toBeVisible();
  const resultBottom = await inspector
    .locator(".delegation-inspector-content")
    .evaluate((element) => element.getBoundingClientRect().bottom);
  const checklistTop = await inspector
    .locator(".delegation-inspector-checklist")
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(checklistTop - resultBottom).toBeLessThan(18);
  const disclosure = inspector.locator('[data-doc="plan.checklist"] button[aria-expanded]').first();
  await expect(disclosure).toBeVisible();
  await expect(inspector).toContainText(view.checks[0]?.operation ?? "", { timeout: 15_000 });
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
  await expect(content.locator('[data-doc="home.card"]')).toHaveCount(roots.length);
  const after = await rpc<{ plans: PlanSummaryView[] }>(request, "plan.list", {});
  expect(after.plans.map((p) => [p.plan, p.revision, p.workState])).toEqual(
    before.plans.map((p) => [p.plan, p.revision, p.workState]),
  );
});

test("A direct child link retains its ancestors and hides its generated ID", async ({ page, request }) => {
  const { plans } = await rpc<{ plans: PlanSummaryView[] }>(request, "plan.list", {});
  const child = plans.find((plan) => plan.mode === "live" && plan.parent);
  if (!child) throw new Error("Read-only acceptance needs a child Plan");
  const chain = [child];
  while (chain[0]?.parent) {
    const parent = plans.find((plan) => plan.plan === chain[0]?.parent?.plan);
    if (!parent || chain.some((plan) => plan.plan === parent.plan)) break;
    chain.unshift(parent);
  }
  const root = chain[0];
  if (!root) throw new Error("Missing root Plan");
  await page.goto(`/delegation?plan=${encodeURIComponent(child.plan)}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { level: 1 })).toBeVisible();
  for (const ancestor of chain) await expect(dialog.locator(`button[data-plan="${ancestor.plan}"]`)).toBeVisible();
  const inspector = dialog.getByRole("article", { name: "Selected Plan" });
  await expect(inspector).toHaveAttribute("data-work-detail", child.plan);
  await expect(inspector.getByRole("link", { name: "Open Plan execution" })).toHaveAttribute(
    "href",
    `/plans/${encodeURIComponent(child.plan)}`,
  );
  await expect(inspector).toContainText(child.procedure);
  await expect(inspector.locator("details code")).not.toBeVisible();
  await inspector.getByText("Technical Plan ID").click();
  await expect(inspector.locator("details code")).toHaveText(child.plan);
  await expect(inspector.locator("details code")).toBeVisible();
});

test("A published root links to its exact catalog version", async ({ page, request }) => {
  const { plans } = await rpc<{ plans: PlanSummaryView[] }>(request, "plan.list", {});
  const { procedures } = await rpc<{ procedures: Array<{ procedure: { procedure: string; version: string } }> }>(
    request,
    "procedure.list",
    {},
  );
  const root = plans.find(
    (plan) =>
      plan.mode === "live" &&
      !plan.parent &&
      plans.some((child) => child.parent?.plan === plan.plan) &&
      procedures.some(
        ({ procedure }) => procedure.procedure === plan.procedure && procedure.version === plan.procedureVersion,
      ),
  );
  if (!root) throw new Error("Read-only acceptance needs a published root Procedure");
  await page.goto(`/delegation?plan=${encodeURIComponent(root.plan)}`);
  const dialog = page.getByRole("dialog");
  await dialog.locator(`button[data-plan="${root.plan}"]`).click();
  const inspector = dialog.getByRole("article", { name: "Selected Plan" });
  await expect(inspector.getByRole("link", { name: "Open Procedure" })).toHaveAttribute(
    "href",
    `/procedures/${encodeURIComponent(root.procedure)}?version=${encodeURIComponent(root.procedureVersion)}`,
  );
});

test("An inline child exposes its pinned Procedure source without a broken catalog link", async ({ page, request }) => {
  const { plans } = await rpc<{ plans: PlanSummaryView[] }>(request, "plan.list", {});
  const { procedures } = await rpc<{ procedures: Array<{ procedure: { procedure: string; version: string } }> }>(
    request,
    "procedure.list",
    {},
  );
  const child = plans.find(
    (plan) =>
      plan.mode === "live" &&
      plan.parent &&
      !procedures.some(
        ({ procedure }) => procedure.procedure === plan.procedure && procedure.version === plan.procedureVersion,
      ),
  );
  if (!child) throw new Error("Read-only acceptance needs an inline child Procedure");
  await page.goto(`/delegation?plan=${encodeURIComponent(child.plan)}`);
  const inspector = page.getByRole("article", { name: "Selected Plan" });
  await expect(inspector).toHaveAttribute("data-work-detail", child.plan);
  await expect(inspector.getByRole("link", { name: "Open Procedure" })).toHaveCount(0);
  const source = inspector.getByRole("button", { name: "View pinned Procedure" });
  await expect(source).toHaveAttribute("aria-expanded", "false");
  await source.click();
  await expect(source).toHaveAttribute("aria-expanded", "true");
  await expect(inspector.locator("pre")).toContainText(`@procedure:${child.procedure}`);
});

test("Delegation list and detail work at a narrow viewport", async ({ page, request }) => {
  const { plans } = await rpc<{ plans: PlanSummaryView[] }>(request, "plan.list", {});
  const parent = plans.find((p) => p.mode === "live" && plans.some((c) => c.parent?.plan === p.plan));
  if (!parent) throw new Error("Missing delegation");
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto("/delegation?view=list");
  await expect(page.getByRole("list", { name: "Delegation tree" })).toBeVisible();
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
