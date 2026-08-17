import { i18next } from "../../i18n/index.js";
import type { CompiledProcedure, PlanCheck, PlanMode, PlanSummary, PublishedProcedure } from "../../types.js";
import { orderedScenarios } from "../procedures/model.js";

/* Plans as list rows: one engaged Plan (live or dry-run) of a published Procedure on an environment. */

type ViewMode = "cards" | "list";
type SortKey = "recent" | "name" | "progress";
export type GroupKey = "none" | "procedure" | "environment";
type StateFilter = "" | "running" | "complete" | "unavailable";

export interface PlanRow {
  id: string;
  procedure: string;
  procedureVersion: string;
  procedureTitle: string;
  environment: string;
  mode: PlanMode;
  revision: number;
  createdAt: string;
  sessionState: PlanSummary["sessionState"];
  workState: PlanSummary["workState"];
  satisfied: number;
  total: number;
  progress: number;
  summary: PlanSummary;
}

export function toRows(plans: PlanSummary[], procedures: PublishedProcedure[]): PlanRow[] {
  return plans.map((plan) => {
    const published = procedures.find(({ procedure }) => procedure.procedure === plan.procedure && procedure.version === plan.procedureVersion)
      ?? procedures.find(({ procedure }) => procedure.procedure === plan.procedure);
    return {
      id: plan.plan,
      procedure: plan.procedure,
      procedureVersion: plan.procedureVersion,
      procedureTitle: published?.procedure.title ?? plan.procedure,
      environment: plan.environment,
      mode: plan.mode,
      revision: plan.revision,
      createdAt: plan.createdAt,
      sessionState: plan.sessionState,
      workState: plan.workState,
      satisfied: plan.satisfiedChecks,
      total: plan.checkCount,
      progress: plan.checkCount ? plan.satisfiedChecks / plan.checkCount : 0,
      summary: plan,
    };
  });
}

/** Plan Checks in procedure order — scenarios topologically, Checks as written, then each expansion — the same order as the graph. */
export function orderedChecks(checks: readonly PlanCheck[], compiled: CompiledProcedure | undefined): PlanCheck[] {
  if (!compiled) return [...checks];
  const index = new Map<string, number>();
  let position = 0;
  for (const scenario of orderedScenarios(compiled)) for (const name of scenario.checks) index.set(name, position++);
  return [...checks].sort((a, b) =>
    (index.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (index.get(b.name) ?? Number.MAX_SAFE_INTEGER)
    || String(a.target.value).localeCompare(String(b.target.value)));
}

export interface Filters {
  q: string;
  procedures: string[];
  environments: string[];
  mode: PlanMode | "";
  state: StateFilter;
  sort: SortKey;
  group: GroupKey;
  view: ViewMode;
}

export function readFilters(params: URLSearchParams): Filters {
  const sort = params.get("sort");
  const group = params.get("group");
  const mode = params.get("mode");
  const state = params.get("state");
  return {
    q: params.get("q") ?? "",
    procedures: (params.get("procedure") ?? "").split(",").filter(Boolean),
    environments: (params.get("env") ?? "").split(",").filter(Boolean),
    mode: mode === "live" || mode === "dry-run" ? mode : "",
    state: state === "running" || state === "complete" || state === "unavailable" ? state : "",
    sort: sort === "name" || sort === "progress" ? sort : "recent",
    group: group === "procedure" || group === "environment" ? group : "none",
    view: params.get("view") === "list" ? "list" : "cards",
  };
}

export function writeFilters(filters: Filters, base: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(base);
  const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
  set("q", filters.q);
  set("procedure", filters.procedures.join(","));
  set("env", filters.environments.join(","));
  set("mode", filters.mode);
  set("state", filters.state);
  set("sort", filters.sort === "recent" ? "" : filters.sort);
  set("group", filters.group === "none" ? "" : filters.group);
  set("view", filters.view === "cards" ? "" : filters.view);
  return next;
}

export const emptyFilters: Pick<Filters, "q" | "procedures" | "environments" | "mode" | "state"> = { q: "", procedures: [], environments: [], mode: "", state: "" };

function matchesQuery(row: PlanRow, needle: string): boolean {
  if (!needle) return true;
  return `${row.id} ${row.procedure} ${row.procedureTitle} ${row.environment} ${row.mode}`.toLowerCase().includes(needle);
}

export function matchReason(row: PlanRow, q: string): string | undefined {
  const needle = q.trim().toLowerCase();
  if (!needle || row.id.toLowerCase().includes(needle)) return undefined;
  if (row.procedureTitle.toLowerCase().includes(needle) || row.procedure.toLowerCase().includes(needle)) return i18next.t("plans.match.procedure", { procedure: row.procedure });
  if (row.environment.toLowerCase().includes(needle)) return i18next.t("plans.match.environment", { environment: row.environment });
  return undefined;
}

function stateOf(row: PlanRow): StateFilter {
  if (row.sessionState === "UNAVAILABLE") return "unavailable";
  return row.workState === "COMPLETE" ? "complete" : "running";
}

export function applyFacets(rows: PlanRow[], filters: Filters, except?: keyof Filters): PlanRow[] {
  return rows.filter((row) =>
    (except === "procedures" || filters.procedures.length === 0 || filters.procedures.includes(row.procedure))
    && (except === "environments" || filters.environments.length === 0 || filters.environments.includes(row.environment))
    && (except === "mode" || !filters.mode || row.mode === filters.mode)
    && (except === "state" || !filters.state || stateOf(row) === filters.state));
}

export function applyFilters(rows: PlanRow[], filters: Filters): PlanRow[] {
  const needle = filters.q.trim().toLowerCase();
  const filtered = applyFacets(rows, filters).filter((row) => matchesQuery(row, needle));
  return filtered.sort((a, b) => {
    if (filters.sort === "name") return a.id.localeCompare(b.id);
    if (filters.sort === "progress") return b.progress - a.progress || a.id.localeCompare(b.id);
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function groupRows(rows: PlanRow[], group: GroupKey): Array<{ key: string; label: string; rows: PlanRow[] }> {
  if (group === "none") return [{ key: "all", label: "", rows }];
  const map = new Map<string, { key: string; label: string; rows: PlanRow[] }>();
  for (const row of rows) {
    const key = group === "procedure" ? row.procedure : row.environment;
    const label = group === "procedure" ? row.procedureTitle : row.environment;
    const entry = map.get(key) ?? { key, label, rows: [] };
    entry.rows.push(row);
    map.set(key, entry);
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}
