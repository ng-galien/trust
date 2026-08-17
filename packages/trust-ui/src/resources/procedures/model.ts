import { i18next } from "../../i18n/index.js";
import type { CompiledProcedure, JsonObject, PlanSummary, PublishedProcedure } from "../../types.js";
import { type Family, familyOf, otherFamily } from "../operations/classification.js";

type ViewMode = "cards" | "list";
type SortKey = "name" | "published" | "checks" | "plans";
export type GroupKey = "none" | "family";

export interface ProcedureRow {
  published: PublishedProcedure;
  procedure: CompiledProcedure;
  id: string;
  version: string;
  title: string;
  description: string | undefined;
  operations: string[];
  domains: string[];
  family: Family;
  inputs: string[];
  scenarioCount: number;
  checkCount: number;
  plans: PlanSummary[];
  activePlans: PlanSummary[];
  publishedAt: string;
  publishedBy: string;
}

export function toRows(procedures: PublishedProcedure[], plans: PlanSummary[]): ProcedureRow[] {
  return procedures.map((published) => {
    const procedure = published.procedure;
    const operations = Array.from(new Set(procedure.operations.map((used) => used.operation))).sort();
    const domains = Array.from(new Set(operations.map((operation) => operation.split(".")[0] ?? "").filter(Boolean)));
    const executing = plans.filter((plan) => plan.procedure === procedure.procedure);
    return {
      published,
      procedure,
      id: procedure.procedure,
      version: procedure.version,
      title: procedure.title,
      description: procedure.description,
      operations,
      domains,
      family: dominantFamily(operations, procedure),
      inputs: procedure.roles.filter((role) => (role.source as { kind?: string }).kind === "plan-input").map((role) => role.name),
      scenarioCount: procedure.scenarios.length,
      checkCount: procedure.checks.length,
      plans: executing,
      activePlans: executing.filter((plan) => plan.workState === "IN_PROGRESS"),
      publishedAt: published.publishedAt,
      publishedBy: published.publishedBy,
    };
  });
}

/** Family of the operations a procedure uses (most frequent), derived until procedures carry tags. */
function dominantFamily(operations: string[], procedure: CompiledProcedure): Family {
  const votes = new Map<string, { family: Family; count: number }>();
  for (const used of procedure.operations) {
    const family = familyOf(used.operation.split(".")[0] ?? "", used.definition);
    const entry = votes.get(family.id) ?? { family, count: 0 };
    entry.count += 1;
    votes.set(family.id, entry);
  }
  return Array.from(votes.values()).sort((a, b) => b.count - a.count)[0]?.family ?? otherFamily;
}

export interface Filters {
  q: string;
  family: string;
  operations: string[];
  plans: "active" | "any" | "none" | "";
  sort: SortKey;
  group: GroupKey;
  view: ViewMode;
}

export function readFilters(params: URLSearchParams): Filters {
  const sort = params.get("sort");
  const group = params.get("group");
  const plans = params.get("plans");
  return {
    q: params.get("q") ?? "",
    family: params.get("family") ?? "",
    operations: (params.get("op") ?? "").split(",").filter(Boolean),
    plans: plans === "active" || plans === "any" || plans === "none" ? plans : "",
    sort: sort === "published" || sort === "checks" || sort === "plans" ? sort : "name",
    group: group === "family" ? group : "none",
    view: params.get("view") === "list" ? "list" : "cards",
  };
}

export function writeFilters(filters: Filters, base: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(base);
  const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
  set("q", filters.q);
  set("family", filters.family);
  set("op", filters.operations.join(","));
  set("plans", filters.plans);
  set("sort", filters.sort === "name" ? "" : filters.sort);
  set("group", filters.group === "none" ? "" : filters.group);
  set("view", filters.view === "cards" ? "" : filters.view);
  return next;
}

export const emptyFilters: Pick<Filters, "q" | "family" | "operations" | "plans"> = { q: "", family: "", operations: [], plans: "" };

function matchesQuery(row: ProcedureRow, needle: string): boolean {
  if (!needle) return true;
  return (
    `${row.id} ${row.title}`.toLowerCase().includes(needle) ||
    row.operations.some((operation) => operation.toLowerCase().includes(needle)) ||
    row.procedure.checks.some((check) => check.name.toLowerCase().includes(needle)) ||
    row.inputs.some((input) => input.toLowerCase().includes(needle))
  );
}

export function matchReason(row: ProcedureRow, q: string): string | undefined {
  const needle = q.trim().toLowerCase();
  if (!needle || `${row.id} ${row.title}`.toLowerCase().includes(needle)) return undefined;
  const operation = row.operations.find((entry) => entry.toLowerCase().includes(needle));
  if (operation) return i18next.t("procedures.model.matchUses", { operation });
  const check = row.procedure.checks.find((entry) => entry.name.toLowerCase().includes(needle));
  if (check) return i18next.t("procedures.model.matchCheck", { name: check.name });
  const input = row.inputs.find((entry) => entry.toLowerCase().includes(needle));
  if (input) return i18next.t("procedures.model.matchNeeds", { input });
  return undefined;
}

export function applyFacets(rows: ProcedureRow[], filters: Filters, except?: keyof Filters): ProcedureRow[] {
  const needle = filters.q.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (except === "q" || matchesQuery(row, needle)) &&
      (except === "family" || !filters.family || row.family.id === filters.family) &&
      (except === "operations" || filters.operations.length === 0 || filters.operations.some((operation) => row.operations.includes(operation))) &&
      (except === "plans" || !filters.plans || (filters.plans === "active" ? row.activePlans.length > 0 : filters.plans === "any" ? row.plans.length > 0 : row.plans.length === 0)),
  );
}

export function applyFilters(rows: ProcedureRow[], filters: Filters): ProcedureRow[] {
  const compare: Record<SortKey, (a: ProcedureRow, b: ProcedureRow) => number> = {
    name: (a, b) => a.id.localeCompare(b.id),
    published: (a, b) => b.publishedAt.localeCompare(a.publishedAt),
    checks: (a, b) => b.checkCount - a.checkCount || a.id.localeCompare(b.id),
    plans: (a, b) => b.activePlans.length - a.activePlans.length || b.plans.length - a.plans.length || a.id.localeCompare(b.id),
  };
  return applyFacets(rows, filters).sort(compare[filters.sort]);
}

export function groupRows(rows: ProcedureRow[], group: GroupKey): Array<{ key: string; label: string; rows: ProcedureRow[] }> {
  if (group === "none") return [{ key: "all", label: "", rows }];
  const map = new Map<string, { key: string; label: string; rows: ProcedureRow[] }>();
  for (const row of rows) {
    const entry = map.get(row.family.id) ?? { key: row.family.id, label: row.family.label, rows: [] };
    entry.rows.push(row);
    map.set(row.family.id, entry);
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

/** Scenarios in dependency order (topological, stable on source order). */
export function orderedScenarios(procedure: CompiledProcedure): CompiledProcedure["scenarios"] {
  const done = new Set<string>();
  const ordered: CompiledProcedure["scenarios"] = [];
  let remaining = [...procedure.scenarios];
  while (remaining.length) {
    const ready = remaining.filter((scenario) => scenario.dependencies.every((dependency) => done.has(dependency)));
    if (ready.length === 0) {
      ordered.push(...remaining);
      break;
    }
    for (const scenario of ready) {
      ordered.push(scenario);
      done.add(scenario.slug);
    }
    remaining = remaining.filter((scenario) => !done.has(scenario.slug));
  }
  return ordered;
}

/** Human reading of a predicate expectation (compiler kinds: value, number, valid-rfc3339, context, check-field). */
export function describeExpectation(expectation: JsonObject): string {
  const kind = expectation.kind;
  if (kind === "value" || kind === "number") return JSON.stringify(expectation.value);
  if (kind === "valid-rfc3339") return i18next.t("procedures.model.validRfc3339");
  if (kind === "context") return i18next.t("procedures.model.contextRole", { role: String(expectation.role ?? "") });
  if (kind === "check-field") return i18next.t("procedures.model.checkField", { check: String(expectation.check ?? ""), field: String(expectation.field ?? "") });
  return JSON.stringify(expectation);
}

export const procedureTemplate = `# language: en
@trust-dsl:1 @procedure:domain.action @version:1.0.0
Feature: Describe what this procedure establishes

  Background: Plan context
    Given one reference "repository"

  @scenario:repository-status
  Scenario: Read the repository status
    Then Check "repository status" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the repository has local changes"
      | field       | relation | expectation   | failure reason                        |
      | workingTree | equals   | value "dirty" | "the repository has no local changes" |
    And the Scenario is satisfied when every Check is validated
`;
