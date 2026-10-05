import { type APIRequestContext, expect, test } from "@playwright/test";

import { runtimeRpc } from "./support/runtime.js";

interface CancellationView {
  readonly workState: string;
  readonly cancellation: { readonly cancelledAt: string; readonly reason: string } | null;
}

const run = Date.now().toString(36);

async function engage(request: APIRequestContext, plan: string, environment = "local"): Promise<void> {
  await runtimeRpc(request, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan,
    environment,
    rootInputs: { repository: "trust" },
  });
}

test("PCN-030 AC1 the Plan list shows the cancelled state and the count of Plans in progress excludes a cancelled Plan", async ({
  page,
  request,
}) => {
  // A dedicated environment isolates the facet counts from the other Plans of the acceptance runtime.
  const environment = `pcn-list-${run}`;
  const kept = `pcn-kept-${run}`;
  const cancelled = `pcn-cancelled-${run}`;
  await runtimeRpc(request, "environment.save", { environment, values: { workspaceRoot: "/tmp" } });
  await engage(request, kept, environment);
  await engage(request, cancelled, environment);
  await runtimeRpc(request, "plan.cancel", { plan: cancelled, reason: "Nobody will finish this Plan." });

  await page.goto(`/plans?env=${environment}&view=list`);
  const rowOf = (plan: string) => page.getByRole("row").filter({ hasText: plan });
  await expect(rowOf(cancelled).getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(rowOf(kept).getByText("In progress", { exact: true })).toBeVisible();
  await expect(rowOf(cancelled).getByText("In progress", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Filters" });
  await expect(picker.getByRole("menuitemcheckbox", { name: "In progress 1", exact: true })).toBeVisible();
  await expect(picker.getByRole("menuitemcheckbox", { name: "Cancelled 1", exact: true })).toBeVisible();

  await picker.getByRole("menuitemcheckbox", { name: "Cancelled 1", exact: true }).click();
  await expect(rowOf(cancelled)).toBeVisible();
  await expect(rowOf(kept)).toHaveCount(0);
});

test("PCN-030 AC2 the Plan page offers the cancellation to a caller with the right, asks a reason and a confirmation, then shows the cancelled state with date, author and reason", async ({
  page,
  request,
}) => {
  const plan = `pcn-page-${run}`;
  const raced = `pcn-raced-${run}`;
  const reason = "The thread was withdrawn; nobody will finish this Plan.";
  await engage(request, plan);
  await engage(request, raced);

  // The server's refusal reaches the operator: the Plan was cancelled elsewhere while the dialog was open.
  await page.goto(`/plans/${raced}`);
  const racedPage = page.getByRole("dialog", { name: raced, exact: true });
  await racedPage.getByRole("button", { name: "Cancel the Plan", exact: true }).click({ timeout: 20_000 });
  const racedConfirm = page.getByRole("alertdialog", { name: `Cancel the Plan “${raced}”?` });
  await racedConfirm.getByRole("textbox", { name: "Cancellation reason" }).fill("Second cancellation.");
  await runtimeRpc(request, "plan.cancel", { plan: raced, reason: "Cancelled elsewhere." });
  await racedConfirm.getByRole("button", { name: "Cancel the Plan", exact: true }).click();
  await expect(racedConfirm.getByRole("alert")).toContainText("The Plan was not cancelled");
  await racedConfirm.getByRole("button", { name: "Keep the Plan", exact: true }).click();
  await expect(racedConfirm).toHaveCount(0);

  await page.goto(`/plans/${plan}`);
  const planPage = page.getByRole("dialog", { name: plan, exact: true });
  await expect(planPage.getByText("In progress", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await planPage.getByRole("button", { name: "Cancel the Plan", exact: true }).click();

  const confirm = page.getByRole("alertdialog", { name: `Cancel the Plan “${plan}”?` });
  const submit = confirm.getByRole("button", { name: "Cancel the Plan", exact: true });
  await expect(submit).toBeDisabled();
  await confirm.getByRole("textbox", { name: "Cancellation reason" }).fill(reason);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(confirm).toHaveCount(0);

  const recorded = await runtimeRpc<CancellationView>(request, "plan.read", { plan });
  expect(recorded.workState).toBe("CANCELLED");
  const notice = planPage.getByRole("region", { name: "Plan cancelled" });
  await expect(notice).toBeVisible();
  await expect(notice.locator(`time[datetime="${recorded.cancellation?.cancelledAt}"]`)).toBeVisible();
  await expect(notice.getByText("Local access (unauthenticated)", { exact: true })).toBeVisible();
  await expect(notice.getByText(reason, { exact: true })).toBeVisible();
  await expect(planPage.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await expect(planPage.getByRole("button", { name: "Cancel the Plan", exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("dialog", { name: plan, exact: true }).getByText(reason, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});
