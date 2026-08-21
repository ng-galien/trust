import { operationLanguage } from "@trust/operation/language";

import { i18next } from "../../i18n/index.js";
import type { CompiledOperation, JsonObject, OperationEnvironments, PublishedProcedure } from "../../types.js";
import { type Family, familyOf, type Nature, natureOf } from "./classification.js";

type ViewMode = "cards" | "list";
export type StepType = "shell" | "http" | "file-read";
type SortKey = "name" | "version" | "steps" | "usage";
export type GroupKey = "none" | "domain" | "family";

/** Display label of a step type; unknown types fall back to the raw value. */
export function stepTypeLabel(type: string): string {
  switch (type) {
    case "shell": return i18next.t("operations.stepTypes.shell");
    case "http": return i18next.t("operations.stepTypes.http");
    case "file-read": return i18next.t("operations.stepTypes.fileRead");
    default: return type;
  }
}

export interface OperationRow {
  operation: CompiledOperation;
  id: string;
  domain: string;
  action: string;
  stepTypes: StepType[];
  inputs: string[];
  environment: string[];
  produced: string[];
  usedBy: PublishedProcedure[];
  family: Family;
  nature: Nature;
  /** Configured environments able to run the operation (from the runtime), undefined until known. */
  runnableOn: string[] | undefined;
}

export function schemaKeys(schema: JsonObject | undefined): string[] {
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties ? Object.keys(properties) : [];
}

export function toRows(operations: CompiledOperation[], procedures: PublishedProcedure[], environments?: OperationEnvironments[]): OperationRow[] {
  return operations.map((operation) => {
    const known = environments?.find((entry) => entry.operation === operation.operation && entry.version === operation.version);
    const [domain, ...rest] = operation.operation.split(".");
    return {
      operation,
      id: operation.operation,
      domain: rest.length ? domain! : "",
      action: rest.length ? rest.join(".") : operation.operation,
      stepTypes: Array.from(new Set(operation.steps.map((step) => step.type))),
      inputs: schemaKeys(operation.input),
      environment: schemaKeys(operation.environment),
      produced: schemaKeys(operation.produced),
      usedBy: procedures.filter(({ procedure }) => procedure.operations.some((used) => used.operation === operation.operation)),
      family: familyOf(rest.length ? domain! : "", operation),
      nature: natureOf(operation),
      runnableOn: known ? known.environments.filter((entry) => entry.compatible).map((entry) => entry.name) : undefined,
    };
  });
}

export interface Filters {
  q: string;
  family: string;
  domains: string[];
  types: StepType[];
  nature: Nature | "";
  usage: "used" | "unused" | "";
  runnable: "yes" | "no" | "";
  sort: SortKey;
  group: GroupKey;
  view: ViewMode;
}

const stepTypes: StepType[] = ["shell", "http", "file-read"];

export function readFilters(params: URLSearchParams): Filters {
  const sort = params.get("sort");
  const group = params.get("group");
  const nature = params.get("nature");
  const usage = params.get("usage");
  const runnable = params.get("runnable");
  return {
    q: params.get("q") ?? "",
    family: params.get("family") ?? "",
    domains: (params.get("domain") ?? "").split(",").filter(Boolean),
    types: (params.get("type") ?? "").split(",").filter((value): value is StepType => stepTypes.includes(value as StepType)),
    nature: nature === "observe" || nature === "act" ? nature : "",
    usage: usage === "used" || usage === "unused" ? usage : "",
    runnable: runnable === "yes" || runnable === "no" ? runnable : "",
    sort: sort === "version" || sort === "steps" || sort === "usage" ? sort : "name",
    group: group === "domain" || group === "family" ? group : "none",
    view: params.get("view") === "list" ? "list" : "cards",
  };
}

export function writeFilters(filters: Filters, base: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(base);
  const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
  set("q", filters.q);
  set("family", filters.family);
  set("domain", filters.domains.join(","));
  set("type", filters.types.join(","));
  set("nature", filters.nature);
  set("usage", filters.usage);
  set("runnable", filters.runnable);
  set("sort", filters.sort === "name" ? "" : filters.sort);
  set("group", filters.group === "none" ? "" : filters.group);
  set("view", filters.view === "cards" ? "" : filters.view);
  return next;
}

export const emptyFilters: Pick<Filters, "q" | "family" | "domains" | "types" | "nature" | "usage" | "runnable"> = { q: "", family: "", domains: [], types: [], nature: "", usage: "", runnable: "" };

/** Why a row matches the free-text query, when it is not the id or the title. */
export function matchReason(row: OperationRow, q: string): string | undefined {
  const needle = q.trim().toLowerCase();
  if (!needle) return undefined;
  if (`${row.id} ${row.operation.title}`.toLowerCase().includes(needle)) return undefined;
  const hit = (names: string[]) => names.find((name) => name.toLowerCase().includes(needle));
  const produced = hit(row.produced);
  if (produced) return i18next.t("operations.model.matchProduces", { name: produced });
  const input = hit(row.inputs);
  if (input) return i18next.t("operations.model.matchNeedsInput", { name: input });
  const environment = hit(row.environment);
  if (environment) return i18next.t("operations.model.matchNeedsEnvironment", { name: environment });
  return undefined;
}

function matchesQuery(row: OperationRow, needle: string): boolean {
  if (!needle) return true;
  return (
    `${row.id} ${row.operation.title}`.toLowerCase().includes(needle) ||
    [...row.produced, ...row.inputs, ...row.environment].some((name) => name.toLowerCase().includes(needle))
  );
}

/** Applies every facet except `except`, so facet counts reflect the other selections. */
export function applyFacets(rows: OperationRow[], filters: Filters, except?: keyof Filters): OperationRow[] {
  const needle = filters.q.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (except === "q" || matchesQuery(row, needle)) &&
      (except === "family" || !filters.family || row.family.id === filters.family) &&
      (except === "domains" || filters.domains.length === 0 || filters.domains.includes(row.domain)) &&
      (except === "types" || filters.types.length === 0 || filters.types.some((type) => row.stepTypes.includes(type))) &&
      (except === "nature" || !filters.nature || row.nature === filters.nature) &&
      (except === "usage" || !filters.usage || (filters.usage === "used" ? row.usedBy.length > 0 : row.usedBy.length === 0)) &&
      (except === "runnable" || !filters.runnable || (filters.runnable === "yes" ? (row.runnableOn?.length ?? 0) > 0 : (row.runnableOn?.length ?? 0) === 0)),
  );
}

export function applyFilters(rows: OperationRow[], filters: Filters): OperationRow[] {
  const compare: Record<SortKey, (a: OperationRow, b: OperationRow) => number> = {
    name: (a, b) => a.id.localeCompare(b.id),
    version: (a, b) => b.operation.version.localeCompare(a.operation.version, undefined, { numeric: true }) || a.id.localeCompare(b.id),
    steps: (a, b) => b.operation.steps.length - a.operation.steps.length || a.id.localeCompare(b.id),
    usage: (a, b) => b.usedBy.length - a.usedBy.length || a.id.localeCompare(b.id),
  };
  return applyFacets(rows, filters).sort(compare[filters.sort]);
}

export function groupRows(rows: OperationRow[], group: GroupKey): Array<{ key: string; label: string; rows: OperationRow[] }> {
  if (group === "none") return [{ key: "all", label: "", rows }];
  const map = new Map<string, { key: string; label: string; rows: OperationRow[] }>();
  for (const row of rows) {
    const key = group === "domain" ? row.domain || "—" : row.family.id;
    const label = group === "domain" ? row.domain || i18next.t("operations.model.noDomain") : row.family.label;
    const entry = map.get(key) ?? { key, label, rows: [] };
    entry.rows.push(row);
    map.set(key, entry);
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export const operationTemplate = operationLanguage.template;
