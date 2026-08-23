import { expect, test, type APIRequestContext } from "@playwright/test";

import { runtimeRpc } from "./support/runtime.js";

interface PlanView {
  readonly actionableChecks: readonly string[];
}

interface Admission {
  readonly attemptKey: string;
  readonly attemptHandle: string;
  readonly executionId: string;
  readonly checkUri: string;
  readonly operation: { readonly operation: string };
}

test("an open checklist follows successive verdict revisions without a reload", async ({ page, request }) => {
  const plan = "live-checklist-acceptance";
  await runtimeRpc(request, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "git-status",
    procedureVersion: "2.0.0",
    plan,
    environment: "local",
    rootInputs: { repository: "trust" },
    mode: "dry-run",
  });

  await page.goto(`/dry-runs/${plan}`);
  await page.getByRole("tab", { name: "Expert" }).click();
  const dialog = page.getByRole("dialog", { name: plan });
  await expect(page.getByRole("button", { name: "Runtime live" })).toBeVisible();
  await expect(dialog.getByText(/revision 1 · engaged/)).toBeVisible();
  await expect(dialog.getByText("0/1", { exact: true }).first()).toBeVisible();

  await observeRepository(request, plan, "clean", "live-checklist-clean");
  await expect(dialog.getByText(/revision 2 · engaged/)).toBeVisible();
  await expect(dialog.getByText(/— the repository has no local changes/)).toBeVisible();
  await expect(dialog.getByText("0/1", { exact: true }).first()).toBeVisible();

  await observeRepository(request, plan, "dirty", "live-checklist-dirty");
  await expect(dialog.getByText(/revision 3 · engaged/)).toBeVisible();
  await expect(dialog.getByText("Complete", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1/1", { exact: true }).first()).toBeVisible();
});

async function observeRepository(
  request: APIRequestContext,
  plan: string,
  workingTree: "clean" | "dirty",
  attemptKey: string,
): Promise<void> {
  const view = await runtimeRpc<PlanView>(request, "plan.read", { plan });
  const checkUri = view.actionableChecks[0];
  if (!checkUri) throw new Error(`Plan ${plan} has no actionable Check`);
  const admission = await runtimeRpc<Admission>(request, "check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey,
    checkUri,
  });
  const now = new Date().toISOString();
  await runtimeRpc(request, "check.attempt.facts", {
    contract: "trust.fact-batch-request@1",
    attemptKey: admission.attemptKey,
    attemptHandle: admission.attemptHandle,
    executionId: admission.executionId,
    checkUri: admission.checkUri,
    recordedAt: now,
    facts: [{
      kind: admission.operation.operation,
      observedAt: now,
      values: { headRevision: `${workingTree}-revision`, workingTree },
    }],
  });
  await runtimeRpc(request, "check.attempt.finalize", {
    contract: "trust.attempt-finalization-request@1",
    attemptHandle: admission.attemptHandle,
  });
}
