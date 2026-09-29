import type { CatalogMetadata, OperationEnvironments, PublishedProcedure } from "@trust/extension-sdk";
import type { CompiledOperation, ObjectSchema, OperationStep } from "@trust/operation";
import { operationLanguage } from "@trust/operation/language";
import { compareVersions } from "@trust/operation/version";
import { i18next } from "../../i18n/index.js";
import { catalogIdentities } from "../../lib/catalog-versions.js";
import { catalogTags } from "../shared/catalog-tags.js";
import { type Family, familyOf, type Nature, natureOf } from "./classification.js";

type ViewMode = "cards" | "list";
export type StepType = OperationStep["type"];
type SortKey = "name" | "version" | "steps" | "usage";
export type GroupKey = "none" | "domain" | "family";

/** Every canonical step kind has a presentation label. */
const stepLabels = {
  shell: "operations.stepTypes.shell",
  http: "operations.stepTypes.http",
  "file-read": "operations.stepTypes.fileRead",
  postgresql: "operations.stepTypes.postgresql",
} as const satisfies Record<StepType, string>;
export function stepTypeLabel(type: StepType): string {
  return i18next.t(stepLabels[type]);
}

export interface OperationRow {
  operation: CompiledOperation;
  metadata: CatalogMetadata;
  tags: string[];
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

export function schemaKeys(schema: ObjectSchema | undefined): string[] {
  const properties = schema?.properties;
  return properties ? Object.keys(properties) : [];
}

export function toRows(
  operations: CompiledOperation[],
  procedures: PublishedProcedure[],
  environments?: OperationEnvironments[],
  metadata: CatalogMetadata[] = [],
): OperationRow[] {
  return catalogIdentities(
    operations,
    (value) => value.operation,
    (value) => value.version,
  ).map((operation) => {
    const current: CatalogMetadata = metadata.find(
      (entry) => entry.name === operation.operation && entry.version === operation.version,
    ) ?? {
      kind: "operation" as const,
      name: operation.operation,
      version: operation.version,
      revision: 0,
      title: operation.title,
      ...(operation.description === undefined ? {} : { description: operation.description }),
      classification: operation.classification ?? {},
    };
    const known = environments?.find(
      (entry) => entry.operation === operation.operation && entry.version === operation.version,
    );
    const [domain = "", ...rest] = operation.operation.split(".");
    return {
      operation,
      metadata: current,
      tags: catalogTags(current.classification),
      id: operation.operation,
      domain: rest.length ? domain : "",
      action: rest.length ? rest.join(".") : operation.operation,
      stepTypes: Array.from(new Set(operation.steps.map((step) => step.type))),
      inputs: schemaKeys(operation.input),
      environment: schemaKeys(operation.environment),
      produced: schemaKeys(operation.produced),
      usedBy: procedures.filter(({ procedure }) =>
        procedure.operations.some((used) => used.operation === operation.operation),
      ),
      family: familyOf(rest.length ? domain : "", operation, current.classification),
      nature: natureOf(operation, current.classification),
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

const isStepType = (value: string): value is StepType => Object.hasOwn(stepLabels, value);

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
    types: (params.get("type") ?? "").split(",").filter(isStepType),
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

export const emptyFilters: Pick<Filters, "q" | "family" | "domains" | "types" | "nature" | "usage" | "runnable"> = {
  q: "",
  family: "",
  domains: [],
  types: [],
  nature: "",
  usage: "",
  runnable: "",
};

/** Why a row matches the free-text query, when it is not the id or the title. */
export function matchReason(row: OperationRow, q: string): string | undefined {
  const terms = q.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return undefined;
  const matches = (value: string) => terms.some((term) => value.toLocaleLowerCase().includes(term));
  if (terms.every((term) => `${row.id} ${row.metadata.title}`.toLocaleLowerCase().includes(term))) return undefined;
  if (row.metadata.description && matches(row.metadata.description))
    return i18next.t("operations.model.matchDescription");
  const tag = row.tags.find(matches);
  if (tag) return i18next.t("operations.model.matchTag", { tag });
  const hit = (names: string[]) => names.find(matches);
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
  const classification = Object.entries(row.metadata.classification).flatMap(([key, values]) => [key, ...values]);
  const text = [
    row.id,
    row.metadata.title,
    row.metadata.description ?? "",
    ...classification,
    ...row.produced,
    ...row.inputs,
    ...row.environment,
  ]
    .join(" ")
    .toLocaleLowerCase();
  return needle.split(/\s+/).every((term) => text.includes(term));
}

/** Applies every facet except `except`, so facet counts reflect the other selections. */
export function applyFacets(rows: OperationRow[], filters: Filters, except?: keyof Filters): OperationRow[] {
  const needle = filters.q.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (except === "q" || matchesQuery(row, needle)) &&
      (except === "family" || !filters.family || row.family.id === filters.family) &&
      (except === "domains" || filters.domains.length === 0 || filters.domains.includes(row.domain)) &&
      (except === "types" ||
        filters.types.length === 0 ||
        filters.types.some((type) => row.stepTypes.includes(type))) &&
      (except === "nature" || !filters.nature || row.nature === filters.nature) &&
      (except === "usage" ||
        !filters.usage ||
        (filters.usage === "used" ? row.usedBy.length > 0 : row.usedBy.length === 0)) &&
      (except === "runnable" ||
        !filters.runnable ||
        (filters.runnable === "yes" ? (row.runnableOn?.length ?? 0) > 0 : (row.runnableOn?.length ?? 0) === 0)),
  );
}

export function applyFilters(rows: OperationRow[], filters: Filters): OperationRow[] {
  const compare: Record<SortKey, (a: OperationRow, b: OperationRow) => number> = {
    name: (a, b) => a.id.localeCompare(b.id),
    version: (a, b) => compareVersions(b.operation.version, a.operation.version) || a.id.localeCompare(b.id),
    steps: (a, b) => b.operation.steps.length - a.operation.steps.length || a.id.localeCompare(b.id),
    usage: (a, b) => b.usedBy.length - a.usedBy.length || a.id.localeCompare(b.id),
  };
  return applyFacets(rows, filters).sort(compare[filters.sort]);
}

export function groupRows(
  rows: OperationRow[],
  group: GroupKey,
): Array<{ key: string; label: string; rows: OperationRow[] }> {
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
