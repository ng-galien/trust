import type { CatalogMetadata, PlanSummaryView, PublishedProcedure } from "@trust/extension-sdk";
import type { CompiledProcedure } from "@trust/procedure";
import { procedureLanguage } from "@trust/procedure/language";
import { i18next } from "../../i18n/index.js";
import { catalogIdentities } from "../../lib/catalog-versions.js";
import { type Family, familyOf, otherFamily } from "../operations/classification.js";
import { catalogTags } from "../shared/catalog-tags.js";

type ViewMode = "cards" | "list";
type SortKey = "name" | "published" | "checks" | "plans";
export type GroupKey = "none" | "family";

export interface ProcedureRow {
  published: PublishedProcedure;
  procedure: CompiledProcedure;
  metadata: CatalogMetadata;
  tags: string[];
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
  plans: PlanSummaryView[];
  activePlans: PlanSummaryView[];
  publishedAt: string;
  publishedBy: string;
}

export function toRows(
  procedures: PublishedProcedure[],
  plans: PlanSummaryView[],
  metadata: CatalogMetadata[] = [],
): ProcedureRow[] {
  return catalogIdentities(
    procedures,
    (value) => value.procedure.procedure,
    (value) => value.procedure.version,
  ).map((published) => {
    const procedure = published.procedure;
    const current: CatalogMetadata = metadata.find(
      (entry) => entry.name === procedure.procedure && entry.version === procedure.version,
    ) ?? {
      kind: "procedure" as const,
      name: procedure.procedure,
      version: procedure.version,
      revision: 0,
      title: procedure.title,
      ...(procedure.description === undefined ? {} : { description: procedure.description }),
      classification: {},
    };
    const operations = Array.from(new Set(procedure.operations.map((used) => used.operation))).sort();
    const domains = Array.from(new Set(operations.map((operation) => operation.split(".")[0] ?? "").filter(Boolean)));
    const executing = plans.filter((plan) => plan.procedure === procedure.procedure);
    return {
      published,
      procedure,
      metadata: current,
      tags: catalogTags(current.classification),
      id: procedure.procedure,
      version: procedure.version,
      title: current.title,
      description: current.description,
      operations,
      domains,
      family: current.classification.family?.[0]
        ? familyOf("", undefined, current.classification)
        : dominantFamily(procedure),
      inputs: procedure.roles.filter((role) => role.source.kind === "plan-input").map((role) => role.name),
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
function dominantFamily(procedure: CompiledProcedure): Family {
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

export const emptyFilters: Pick<Filters, "q" | "family" | "operations" | "plans"> = {
  q: "",
  family: "",
  operations: [],
  plans: "",
};

function matchesQuery(row: ProcedureRow, needle: string): boolean {
  if (!needle) return true;
  const classification = Object.entries(row.metadata.classification).flatMap(([key, values]) => [key, ...values]);
  const text = [
    row.id,
    row.title,
    row.description ?? "",
    ...classification,
    ...row.operations,
    ...row.procedure.checks.map((check) => check.name),
    ...row.inputs,
  ]
    .join(" ")
    .toLocaleLowerCase();
  return needle.split(/\s+/).every((term) => text.includes(term));
}

export function matchReason(row: ProcedureRow, q: string): string | undefined {
  const terms = q.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return undefined;
  const matches = (value: string) => terms.some((term) => value.toLocaleLowerCase().includes(term));
  if (terms.every((term) => `${row.id} ${row.title}`.toLocaleLowerCase().includes(term))) return undefined;
  if (row.description && matches(row.description)) return i18next.t("procedures.model.matchDescription");
  const tag = row.tags.find(matches);
  if (tag) return i18next.t("procedures.model.matchTag", { tag });
  const operation = row.operations.find(matches);
  if (operation) return i18next.t("procedures.model.matchUses", { operation });
  const check = row.procedure.checks.find((entry) => matches(entry.name));
  if (check) return i18next.t("procedures.model.matchCheck", { name: check.name });
  const input = row.inputs.find(matches);
  if (input) return i18next.t("procedures.model.matchNeeds", { input });
  return undefined;
}

export function applyFacets(rows: ProcedureRow[], filters: Filters, except?: keyof Filters): ProcedureRow[] {
  const needle = filters.q.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (except === "q" || matchesQuery(row, needle)) &&
      (except === "family" || !filters.family || row.family.id === filters.family) &&
      (except === "operations" ||
        filters.operations.length === 0 ||
        filters.operations.some((operation) => row.operations.includes(operation))) &&
      (except === "plans" ||
        !filters.plans ||
        (filters.plans === "active"
          ? row.activePlans.length > 0
          : filters.plans === "any"
            ? row.plans.length > 0
            : row.plans.length === 0)),
  );
}

export function applyFilters(rows: ProcedureRow[], filters: Filters): ProcedureRow[] {
  const compare: Record<SortKey, (a: ProcedureRow, b: ProcedureRow) => number> = {
    name: (a, b) => a.id.localeCompare(b.id),
    published: (a, b) => b.publishedAt.localeCompare(a.publishedAt),
    checks: (a, b) => b.checkCount - a.checkCount || a.id.localeCompare(b.id),
    plans: (a, b) =>
      b.activePlans.length - a.activePlans.length || b.plans.length - a.plans.length || a.id.localeCompare(b.id),
  };
  return applyFacets(rows, filters).sort(compare[filters.sort]);
}

export function groupRows(
  rows: ProcedureRow[],
  group: GroupKey,
): Array<{ key: string; label: string; rows: ProcedureRow[] }> {
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
  const ordered: Array<CompiledProcedure["scenarios"][number]> = [];
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

export const procedureTemplate = procedureLanguage.template;

export function hasIntentChaining(source: string): boolean {
  const lines = source.split(/\r?\n/);
  const featureLine = lines.findIndex((line) => /^[ \t]*Feature:/.test(line));
  return (
    featureLine >= 0 &&
    lines.slice(0, featureLine).some((line) => tagTokens(line).includes(procedureLanguage.tags.intentChaining))
  );
}

export function setIntentChaining(source: string, enabled: boolean): string {
  const tag = procedureLanguage.tags.intentChaining;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const featureLine = lines.findIndex((line) => /^[ \t]*Feature:/.test(line));
  if (featureLine < 0) return source;
  const present = lines.slice(0, featureLine).some((line) => tagTokens(line).includes(tag));
  for (const [index, line] of lines.slice(0, featureLine).entries()) {
    const tokens = tagTokens(line);
    if (!tokens.includes(tag)) continue;
    const indentation = /^[ \t]*/.exec(line)?.[0] ?? "";
    lines[index] = `${indentation}${tokens.filter((token) => token !== tag).join(" ")}`;
  }
  if (enabled && !present) {
    const dslLine = lines
      .slice(0, featureLine)
      .findLastIndex((line) => tagTokens(line).some((token) => token.startsWith(procedureLanguage.tags.dsl)));
    const dsl = lines[dslLine];
    if (dsl !== undefined) lines[dslLine] = `${dsl.trimEnd()} ${tag}`;
    else lines.splice(featureLine, 0, tag);
  }
  return lines.join(newline);
}

function tagTokens(line: string): string[] {
  const trimmed = line.trim();
  return trimmed.startsWith("@") ? trimmed.split(/[ \t]+/).filter(Boolean) : [];
}
