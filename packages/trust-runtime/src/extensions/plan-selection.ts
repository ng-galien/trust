import {
  type AccessContext,
  type ExtensionPlanSelection,
  PLAN_WORK_STATES,
  type PlanListInput,
  type PlanSummaryView,
} from "@trust/extension-sdk";
import type { PlanReader } from "../plan/read.js";

const SELECTION_KEYS = ["procedure", "mode", "workState", "limit"];
const PAGE_SIZE = 200;

/**
 * The Plans an extension asks for: an optional procedure, mode and work state, and an optional bound on their number.
 * Any other key, an unknown mode or work state, or a limit that is not a positive integer makes the selection invalid.
 */
export function parseExtensionPlanSelection(input: unknown): ExtensionPlanSelection | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !SELECTION_KEYS.includes(key))) return undefined;
  const { procedure, mode, workState, limit } = record;
  if (
    (procedure !== undefined && (typeof procedure !== "string" || procedure.length === 0 || procedure.length > 200)) ||
    (mode !== undefined && mode !== "live" && mode !== "dry-run") ||
    (workState !== undefined && !(PLAN_WORK_STATES as readonly unknown[]).includes(workState)) ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1))
  )
    return undefined;
  return record as ExtensionPlanSelection;
}

/** The same selection read from a query string: every value is text and the limit is written in decimal digits. */
export function parseExtensionPlanQuery(query: Readonly<Record<string, unknown>>): ExtensionPlanSelection | undefined {
  if (Object.values(query).some((value) => typeof value !== "string")) return undefined;
  const { limit, ...rest } = query as Record<string, string>;
  if (limit === undefined) return parseExtensionPlanSelection(rest);
  return /^\d+$/u.test(limit) ? parseExtensionPlanSelection({ ...rest, limit: Number(limit) }) : undefined;
}

/** The selected Plans of one environment, newest first, read page after page until the limit is reached. */
export async function listExtensionPlans(
  planReader: PlanReader,
  environment: string,
  selection: ExtensionPlanSelection,
  access: AccessContext | undefined,
): Promise<PlanSummaryView[]> {
  const { limit, ...filter } = selection;
  const query: PlanListInput = {
    ...(Object.keys(filter).length === 0 ? {} : { filter }),
    ...(limit === undefined ? {} : { limit: Math.min(limit, PAGE_SIZE) }),
  };
  const plans: PlanSummaryView[] = [];
  let cursor: string | undefined;
  do {
    const page = await planReader.listPlans(cursor === undefined ? query : { ...query, cursor }, access);
    plans.push(...page.plans.filter((plan) => plan.environment === environment));
    cursor = page.nextCursor;
  } while (cursor !== undefined && (limit === undefined || plans.length < limit));
  return limit === undefined ? plans : plans.slice(0, limit);
}
