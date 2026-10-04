import type {
  AccessContext,
  PlanCancellationResult,
  PlanCancellationView,
  PlanListInput,
  PlanSummaryView,
} from "@trust/extension-sdk";
import { PLAN_WORK_STATES } from "@trust/extension-sdk";
import { type PlanReader, ReadError } from "../plan/read.js";
import { type PlanRuntime, PlanRuntimeError } from "../plan/runtime.js";

export const PLAN_TOOL_NAMES = ["trust_plan_list", "trust_plan_cancel"] as const;
export type PlanToolName = (typeof PLAN_TOOL_NAMES)[number];

export interface McpPlanDependencies {
  readonly access?: AccessContext | undefined;
  readonly planReader: PlanReader;
  readonly planRuntime: PlanRuntime;
}

export class InvalidMcpPlanArguments extends Error {}

export function isPlanToolName(value: unknown): value is PlanToolName {
  return typeof value === "string" && (PLAN_TOOL_NAMES as readonly string[]).includes(value);
}

export async function callPlanTool(
  name: PlanToolName,
  args: Record<string, unknown>,
  dependencies: McpPlanDependencies,
): Promise<{ readonly isError: boolean; readonly text: string }> {
  if (name === "trust_plan_list") {
    const input = planListArguments(args);
    try {
      return {
        isError: false,
        text: renderPlanList(input, await dependencies.planReader.listPlans(input, dependencies.access)),
      };
    } catch (error) {
      if (error instanceof ReadError) return { isError: true, text: `TRUST Plan list failed: ${error.message}` };
      throw error;
    }
  }
  const input = planCancellationArguments(args);
  let result: PlanCancellationResult;
  try {
    result = await dependencies.planRuntime.cancelPlan(input, dependencies.access);
  } catch (error) {
    if (error instanceof PlanRuntimeError)
      return { isError: true, text: `TRUST Plan cancellation refused: ${error.message}` };
    throw error;
  }
  return { isError: false, text: renderCancellation(result) };
}

/** Text form of a cancellation record, shared by the Plan read and the cancellation result. */
export function renderCancellationRecord(plan: string, cancellation: PlanCancellationView): readonly string[] {
  return [
    `Cancelled at: ${cancellation.cancelledAt}`,
    `Cancelled by: ${formatAuthor(cancellation.cancelledBy)}`,
    `Reason: ${cancellation.reason}`,
    ...(cancellation.rootPlan === plan ? [] : [`Cancelled with root Plan: ${cancellation.rootPlan}`]),
  ];
}

function renderCancellation(result: PlanCancellationResult): string {
  const children = result.cancelledPlans.filter((plan) => plan !== result.plan);
  return [
    "PLAN CANCELLATION",
    `Result: ${result.status}`,
    `Plan: ${result.plan}`,
    `Cancelled at: ${result.cancelledAt}`,
    `Cancelled by: ${formatAuthor(result.cancelledBy)}`,
    `Reason: ${result.reason}`,
    `Cancelled child Plans: ${children.length === 0 ? "none" : children.join(", ")}`,
    `Interrupted Attempts: ${result.interruptedAttempts.length === 0 ? "none" : result.interruptedAttempts.join(", ")}`,
    "",
    "NEXT",
    "The Plan is CANCELLED. Do not run a Check, replace declarations, resume or relaunch it. Read it with trust_plan_read: its Checks, Attempts, declarations and revisions stay readable.",
    "",
  ].join("\n");
}

function renderPlanList(
  input: PlanListInput,
  page: { readonly plans: readonly PlanSummaryView[]; readonly nextCursor?: string },
): string {
  const filter = Object.entries(input.filter ?? {}).map(([key, value]) => `${key}=${value}`);
  return [
    "PLANS",
    `Filter: ${filter.length === 0 ? "none" : filter.join(", ")}`,
    `Count: ${page.plans.length}`,
    ...page.plans.flatMap((plan) => [
      `- ${plan.plan}`,
      `  State: ${plan.workState}; Session: ${plan.sessionState}; Mode: ${plan.mode}`,
      `  Procedure: ${plan.procedure}@${plan.procedureVersion}`,
      ...(plan.metadata.title === undefined ? [] : [`  Title: ${plan.metadata.title}`]),
      ...(plan.parent === null ? [] : [`  Parent Plan: ${plan.parent.plan}`]),
      `  Created at: ${plan.createdAt}`,
      `  Progress: ${plan.satisfiedChecks}/${plan.checkCount} current Checks satisfied`,
      ...(plan.cancellation === null
        ? []
        : renderCancellationRecord(plan.plan, plan.cancellation).map((line) => `  ${line}`)),
    ]),
    "",
    "NEXT",
    page.nextCursor === undefined
      ? "No further page. Read one Plan with trust_plan_read."
      : `More Plans exist. Call trust_plan_list with the same filter and cursor ${JSON.stringify(page.nextCursor)}.`,
    "",
  ].join("\n");
}

function formatAuthor(author: PlanCancellationView["cancelledBy"]): string {
  return author === null ? "unauthenticated local access" : `${author.subject} (${author.issuer})`;
}

function planListArguments(value: Record<string, unknown>): PlanListInput {
  const allowed = new Set(["procedure", "mode", "workState", "cursor", "limit"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    (value.procedure !== undefined && !boundedString(value.procedure)) ||
    (value.mode !== undefined && value.mode !== "live" && value.mode !== "dry-run") ||
    (value.workState !== undefined &&
      (typeof value.workState !== "string" || !(PLAN_WORK_STATES as readonly string[]).includes(value.workState))) ||
    (value.cursor !== undefined && !boundedString(value.cursor, 2_048)) ||
    (value.limit !== undefined && !Number.isSafeInteger(value.limit))
  ) {
    throw new InvalidMcpPlanArguments(
      `Plan list arguments are invalid. workState accepts ${PLAN_WORK_STATES.join(", ")}; mode accepts live or dry-run.`,
    );
  }
  const filter = {
    ...(value.procedure === undefined ? {} : { procedure: value.procedure as string }),
    ...(value.mode === undefined ? {} : { mode: value.mode as "live" | "dry-run" }),
    ...(value.workState === undefined
      ? {}
      : { workState: value.workState as NonNullable<NonNullable<PlanListInput["filter"]>["workState"]> }),
  };
  return {
    ...(Object.keys(filter).length === 0 ? {} : { filter }),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
  };
}

/** A missing or blank reason reaches the runtime, which refuses it with an explicit message. */
function planCancellationArguments(value: Record<string, unknown>): { readonly plan: string; readonly reason: string } {
  if (
    Object.keys(value).some((key) => key !== "plan" && key !== "reason") ||
    !boundedString(value.plan) ||
    (value.reason !== undefined && typeof value.reason !== "string")
  ) {
    throw new InvalidMcpPlanArguments("Plan cancellation arguments are invalid");
  }
  return { plan: value.plan, reason: (value.reason as string | undefined) ?? "" };
}

function boundedString(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function planTools(): readonly unknown[] {
  return [
    {
      name: "trust_plan_list",
      title: "List TRUST Plans",
      description:
        "List Plans, newest first, with their work state, Session and progress. Filter by procedure, mode or work state. A cancelled Plan shows when, by whom and why it was cancelled.",
      inputSchema: {
        type: "object",
        properties: {
          procedure: { type: "string", description: "Procedure slug" },
          mode: { type: "string", enum: ["live", "dry-run"], description: "Plan mode" },
          workState: {
            type: "string",
            enum: [...PLAN_WORK_STATES],
            description: "Work state: IN_PROGRESS, ESCALATED, COMPLETE or CANCELLED",
          },
          cursor: { type: "string", description: "Exact cursor returned by the previous page with the same filter" },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum Plans in the page" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "trust_plan_cancel",
      title: "Cancel a TRUST Plan",
      description:
        "Cancel a root Plan with a reason. The Plan and its current child Plans become CANCELLED: their Sessions close, pending Attempts are interrupted, and no Attempt, declaration replacement, resumption or relaunch is admitted afterwards. Nothing is deleted. Refused without a reason, for a child Plan (withdraw its mission instead), for a COMPLETE Plan and for a cancelled Plan.",
      inputSchema: {
        type: "object",
        properties: {
          plan: { type: "string", description: "Root Plan identifier" },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
            description: "Why the Plan is abandoned; recorded with the date and the author",
          },
        },
        required: ["plan", "reason"],
        additionalProperties: false,
      },
    },
  ];
}
