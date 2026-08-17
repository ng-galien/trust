import { Activity, FlaskConical, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { plural, relativeTime } from "../../lib/format.js";
import { useHistory, usePlans, useProcedures } from "../../lib/runtime-context.js";
import type { HistoryFilter, HistorySnapshot, PlanMode } from "../../types.js";
import { StatusBadge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { Expert } from "../../ui/expert.js";
import { type FacetGroupSpec, FilterBox } from "../../ui/filter-box.js";
import { ModeBadge } from "../plans/parts.js";
import { ResourceHome } from "../shared/resource-home.js";
import { ResourceTable } from "../shared/resource-table.js";
import { useUrlFilters } from "../shared/use-url-filters.js";

/* Check history — the audit view: every verdict ever computed, across Plans and dry-runs, newest first.
   Served by the runtime (`history.list`): the facets are applied server-side, pages are appended on demand;
   the free-text search only narrows the pages already loaded. */

interface Filters { q: string; mode: PlanMode | ""; verdict: "" | "VALIDATED" | "NOT_VALIDATED"; procedure: string; plan: string; sort: "recent"; view: "list"; group: "none" | "plan" | "day" }

function readFilters(params: URLSearchParams): Filters {
  const mode = params.get("mode"); const verdict = params.get("verdict"); const group = params.get("group");
  return {
    q: params.get("q") ?? "",
    mode: mode === "live" || mode === "dry-run" ? mode : "",
    verdict: verdict === "VALIDATED" || verdict === "NOT_VALIDATED" ? verdict : "",
    procedure: params.get("procedure") ?? "",
    plan: params.get("plan") ?? "",
    sort: "recent",
    view: "list",
    group: group === "plan" || group === "day" ? group : "none",
  };
}
function writeFilters(filters: Filters, base: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(base);
  const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
  set("q", filters.q); set("mode", filters.mode); set("verdict", filters.verdict);
  set("procedure", filters.procedure); set("plan", filters.plan);
  set("group", filters.group === "none" ? "" : filters.group);
  return next;
}
const emptyFilters: Partial<Filters> = { q: "", mode: "", verdict: "", procedure: "", plan: "" };

export function HistoryHome() {
  const { t } = useTranslation();
  const [filters, update] = useUrlFilters(readFilters, writeFilters, "history");
  const filter: HistoryFilter = {
    ...(filters.mode ? { mode: filters.mode } : {}),
    ...(filters.verdict ? { verdict: filters.verdict } : {}),
    ...(filters.procedure ? { procedure: filters.procedure } : {}),
    ...(filters.plan ? { plan: filters.plan } : {}),
  };
  const history = useHistory(filter);
  const procedures = useProcedures();
  const plans = usePlans();
  const needle = filters.q.trim().toLowerCase();
  const visible = history.rows.filter((row) => !needle || `${row.plan} ${row.checkName} ${row.reason} ${row.operation} ${targetOf(row)}`.toLowerCase().includes(needle));
  const groups = filters.group === "none" ? [{ key: "all", label: "", rows: visible }]
    : Array.from(visible.reduce((map, row) => { const key = filters.group === "plan" ? row.plan : row.calculatedAt.slice(0, 10); map.set(key, [...(map.get(key) ?? []), row]); return map; }, new Map<string, HistorySnapshot[]>()).entries()).map(([key, list]) => ({ key, label: key, rows: list }));
  const pick = (patch: Partial<Filters>, options?: { clearQuery?: boolean }) => update({ ...patch, ...(options?.clearQuery ? { q: "" } : {}) });
  const exclusive = <K extends "mode" | "verdict" | "procedure" | "plan">(key: K, value: string) => pick({ [key]: filters[key] === value ? "" : value } as Partial<Filters>);
  const facetGroups: FacetGroupSpec[] = [
    { id: "verdict", label: t("history.home.facets.verdict"), exclusive: true, selected: filters.verdict ? [filters.verdict] : [], options: [
      { value: "VALIDATED", label: t("history.home.facets.validated") },
      { value: "NOT_VALIDATED", label: t("history.home.facets.notValidated") },
    ], onToggle: (value) => exclusive("verdict", value) },
    { id: "mode", label: t("history.home.facets.mode"), exclusive: true, selected: filters.mode ? [filters.mode] : [], options: [
      { value: "live", label: t("history.home.facets.livePlans"), icon: <Activity /> },
      { value: "dry-run", label: t("history.home.facets.dryRuns"), icon: <FlaskConical /> },
    ], onToggle: (value) => exclusive("mode", value) },
    { id: "procedure", label: t("history.home.facets.procedure"), exclusive: true, selected: filters.procedure ? [filters.procedure] : [], options: (procedures.data ?? []).map(({ procedure }) => ({ value: procedure.procedure, label: procedure.procedure, icon: <Workflow /> })), onToggle: (value) => exclusive("procedure", value) },
    { id: "plan", label: t("history.home.facets.plan"), exclusive: true, selected: filters.plan ? [filters.plan] : [], options: (plans.data ?? []).filter((plan) => !filters.mode || plan.mode === filters.mode).map((plan) => ({ value: plan.plan, label: plan.plan })), onToggle: (value) => exclusive("plan", value) },
  ];

  return (
    <ResourceHome
      crumbs={[{ label: "TRUST", to: "/overview" }, { label: t("history.home.crumb") }]}
      title={t("history.home.title")}
      total={history.rows.length}
      visible={visible.length}
      filterBox={<FilterBox query={filters.q} onQuery={(q) => update({ q })} groups={facetGroups} placeholder={t("history.home.searchPlaceholder")} onClearAll={() => update(emptyFilters)} />}
      display={{
        view: "list", onView: () => undefined,
        group: filters.group, groupOptions: [{ value: "none", label: t("history.home.groupNone") }, { value: "plan", label: t("history.home.groupPlan") }, { value: "day", label: t("history.home.groupDay") }], onGroup: (group) => update({ group }),
        sort: "recent", sortOptions: [{ value: "recent", label: t("history.home.sortRecent") }], onSort: () => undefined,
      }}
      loading={history.isLoading}
      error={history.error?.message}
      emptyTitle={history.rows.length ? t("history.home.emptyTitleNoMatch") : t("history.home.emptyTitleNone")}
      emptyBody={history.rows.length ? t("history.home.emptyBodyNoMatch") : undefined}
      onClearFilters={() => update(emptyFilters)}
      groups={groups}
      renderCards={(list) => <HistoryTable rows={list} />}
      renderList={(list) => <HistoryTable rows={list} />}
      footer={history.hasNextPage ? (
        <div className="flex items-center justify-center gap-3 border-t border-border px-4 py-3 text-body text-muted">
          {t("history.home.loaded", { verdicts: plural(history.rows.length, "verdict") })}
          <Button size="sm" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>{history.isFetchingNextPage ? t("common.actions.loading") : t("common.actions.loadMore")}</Button>
        </div>
      ) : null}
      overlayOpen={false}
    />
  );
}

function targetOf(row: HistorySnapshot): string {
  return `${row.target.role} = ${JSON.stringify(row.target.value)}`;
}

export function HistoryTable({ rows, stickyHeader }: { rows: HistorySnapshot[]; stickyHeader?: boolean }) {
  const { t } = useTranslation();
  return (
    <ResourceTable
      {...(stickyHeader === undefined ? {} : { stickyHeader })}
      columns={[
        { key: "when", label: t("history.table.columns.when"), width: "11%" },
        { key: "verdict", label: t("history.table.columns.verdict"), width: "11%" },
        { key: "check", label: t("history.table.columns.check") },
        { key: "plan", label: t("history.table.columns.plan"), width: "20%" },
        { key: "reason", label: t("history.table.columns.reason"), width: "26%" },
        { key: "facts", label: t("history.table.columns.facts"), width: "8%" },
      ]}
      rows={rows}
      rowKey={(row) => row.snapshotId}
      renderCells={(row) => [
        <span key="w" className="text-body text-muted" title={row.calculatedAt}>{relativeTime(row.calculatedAt)}</span>,
        <StatusBadge key="v" state={row.verdict} />,
        <div key="c" className="min-w-0">
          <div className="flex items-baseline gap-2"><span className="mono text-body-lg font-medium">{row.checkName}</span><Link to={`/operations/${encodeURIComponent(row.operation)}`} className="mono text-caption text-accent hover:underline">{row.operation}</Link></div>
          <span className="mono block truncate text-caption text-muted">{targetOf(row)}</span>
        </div>,
        <div key="p" className="min-w-0">
          <Link to={`/${row.mode === "dry-run" ? "dry-runs" : "plans"}/${encodeURIComponent(row.plan)}?sel=${encodeURIComponent(`check:${row.checkUri}`)}`} className="mono block truncate text-body text-accent hover:underline">{row.plan}</Link>
          <span className="flex items-center gap-1 text-caption text-muted"><ModeBadge mode={row.mode} /> {row.procedure}</span>
        </div>,
        <span key="r" className="text-body">{row.reason}{row.checklistDelta.newlyOpened.length ? <span className="text-graph-data">{t("history.table.reopened", { checks: plural(row.checklistDelta.newlyOpened.length, "check") })}</span> : null}<Expert><span className="block text-meta text-faint">{t("history.table.attempt", { reasonCode: row.reasonCode, handle: row.attemptHandle.slice(0, 8) })}</span></Expert></span>,
        <span key="f" className="text-body text-muted">{row.factCount}</span>,
      ]}
    />
  );
}
