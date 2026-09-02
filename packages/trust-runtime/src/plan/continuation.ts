import type { PlanView } from "./read.js";

export interface NextCheck {
  readonly name: string;
  readonly successReason: string;
  readonly checkUri: string;
  readonly actionScope: {
    readonly authorized: readonly string[];
    readonly forbidden: readonly string[];
  };
}

export type CheckContinuation =
  | { readonly action: "RUN_CHECKS"; readonly checks: readonly NextCheck[] }
  | { readonly action: "RETRY_OR_ESCALATE"; readonly checks: readonly NextCheck[] }
  | { readonly action: "COMPLETE" }
  | { readonly action: "READ_PLAN" };

export function checkContinuation(
  view: PlanView,
  completed?: { readonly checkUri: string; readonly verdict: "VALIDATED" | "NOT_VALIDATED" },
): CheckContinuation {
  if (view.checklistComplete) return { action: "COMPLETE" };
  if (view.workState !== "IN_PROGRESS"
    || view.sessionState !== "OPEN"
    || view.intentChainState === "NOT_STARTED"
    || view.missingDeclarations.length > 0) {
    return { action: "READ_PLAN" };
  }
  const actionable = view.checks.filter((check) => check.actionable);
  if (actionable.length === 0) return { action: "READ_PLAN" };
  if (completed?.verdict === "NOT_VALIDATED") {
    const retry = actionable.find((check) => check.checkUri === completed.checkUri && check.escalatable);
    if (retry !== undefined) {
      return { action: "RETRY_OR_ESCALATE", checks: [nextCheck(view, retry)] };
    }
  }
  return { action: "RUN_CHECKS", checks: actionable.map((check) => nextCheck(view, check)) };
}

function nextCheck(view: PlanView, check: PlanView["checks"][number]): NextCheck {
  return {
    name: check.name,
    successReason: check.successReason,
    checkUri: nextCheckUri(view, check),
    actionScope: check.actionScope,
  };
}

function nextCheckUri(view: PlanView, check: PlanView["checks"][number]): string {
  if (!view.intentChaining) return check.checkUri;
  if (view.intentChainState !== "ACTIVE" || view.currentIntent === null) {
    throw new Error("An actionable intent-chained Check must have one current intent");
  }
  const intent = encodeURIComponent(view.currentIntent);
  return check.completesPlan
    ? `${check.checkUri}?intent=${intent}`
    : `${check.checkUri}?intent=${intent}&nextIntent={nextIntent}`;
}
