import { Server, Workflow } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";

import { relativeTime } from "../../lib/format.js";
import { useExpert } from "../../lib/preferences.js";
import { usePlans, useProcedures } from "../../lib/runtime-context.js";
import type { PlanMode } from "../../types.js";
import { type FacetGroupSpec, FilterBox } from "../../ui/filter-box.js";
import { facetHelpers } from "../shared/facets.js";
import { CardGrid, ResourceCard } from "../shared/resource-card.js";
import { ResourceHome } from "../shared/resource-home.js";
import { ResourceTable, TitleCell } from "../shared/resource-table.js";
import { useUrlFilters } from "../shared/use-url-filters.js";
import { applyFacets, applyFilters, emptyFilters, type Filters, groupRows, matchReason, type PlanRow, readFilters, toRows, writeFilters } from "./model.js";
import { ModeBadge, PlanStateBadges, ProgressBar } from "./parts.js";

/* Live Plans and dry-runs are the same object under the same rules, but they never share a list:
   `/plans` shows what agents execute, `/dry-runs` what the operator rehearses. */
export function PlansHome({ mode }: { mode: PlanMode }) {
  const { t } = useTranslation();
  const base = mode === "dry-run" ? "/dry-runs" : "/plans";
  const plans = usePlans();
  const procedures = useProcedures();
  const location = useLocation();
  const [filters, update] = useUrlFilters(readFilters, writeFilters, mode === "dry-run" ? "dry-runs" : "plans");
  const overlayOpen = location.pathname !== base && location.pathname !== `${base}/`;

  const rows = useMemo(() => toRows((plans.data ?? []).filter((plan) => plan.mode === mode), procedures.data ?? []), [plans.data, procedures.data, mode]);
  const visible = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const groups = useMemo(() => groupRows(visible, filters.group), [visible, filters.group]);

  return (
    <ResourceHome
      crumbs={[{ label: t("plans.brand"), to: "/overview" }, { label: mode === "dry-run" ? t("plans.anchor.dryRuns") : t("plans.anchor.plans") }]}
      title={mode === "dry-run" ? t("plans.anchor.dryRuns") : t("plans.anchor.plans")}
      total={rows.length}
      visible={visible.length}
      createTo={`${base}/new`}
      createLabel={mode === "dry-run" ? t("plans.home.createDryRun") : t("plans.home.createLive")}
      filterBox={<PlanFilters rows={rows} filters={filters} update={update} />}
      display={{
        view: filters.view,
        onView: (view) => update({ view }),
        group: filters.group,
        groupOptions: [{ value: "none", label: t("plans.home.group.none") }, { value: "procedure", label: t("plans.home.group.procedure") }, { value: "environment", label: t("plans.home.group.environment") }],
        onGroup: (group) => update({ group }),
        sort: filters.sort,
        sortOptions: [{ value: "recent", label: t("plans.home.sort.recent") }, { value: "name", label: t("plans.home.sort.name") }, { value: "progress", label: t("plans.home.sort.progress") }],
        onSort: (sort) => update({ sort }),
      }}
      loading={plans.isLoading}
      error={plans.error?.message}
      emptyTitle={rows.length ? (mode === "dry-run" ? t("plans.home.empty.noMatchDryRun") : t("plans.home.empty.noMatchLive")) : mode === "dry-run" ? t("plans.home.empty.noneDryRun") : t("plans.home.empty.noneLive")}
      emptyBody={rows.length ? t("plans.home.empty.adjust") : ""}
      onClearFilters={() => update(emptyFilters)}
      groups={groups}
      renderCards={(list) => <CardsView rows={list} base={base} search={location.search} q={filters.q} />}
      renderList={(list) => <ListView rows={list} base={base} search={location.search} q={filters.q} />}
      overlayOpen={overlayOpen}
    />
  );
}

function PlanFilters({ rows, filters, update }: { rows: PlanRow[]; filters: Filters; update: (patch: Partial<Filters>) => void }) {
  const { t } = useTranslation();
  const { count, toggle, pick } = facetHelpers(rows, filters, applyFacets, update);
  const procedures = Array.from(new Map(rows.map((row) => [row.procedure, row.procedureTitle])).entries()).sort((a, b) => a[1].localeCompare(b[1]));
  const environments = Array.from(new Set(rows.map((row) => row.environment))).sort();
  const groups: FacetGroupSpec[] = [
    {
      id: "state",
      label: t("plans.home.filters.state"),
      exclusive: true,
      selected: filters.state ? [filters.state] : [],
      options: [
        { value: "running", label: t("plans.home.filters.running"), count: count("state", (row) => row.workState === "IN_PROGRESS" && row.sessionState === "OPEN") },
        { value: "escalated", label: t("plans.home.filters.escalated"), count: count("state", (row) => row.workState === "ESCALATED") },
        { value: "complete", label: t("plans.home.filters.complete"), count: count("state", (row) => row.workState === "COMPLETE" && row.sessionState === "OPEN") },
        { value: "unavailable", label: t("plans.home.filters.unavailable"), count: count("state", (row) => row.workState !== "ESCALATED" && row.sessionState === "UNAVAILABLE") },
      ],
      onToggle: (value, options) => pick({ state: filters.state === value ? "" : (value as Filters["state"]) }, options),
    },
    {
      id: "procedure",
      label: t("plans.home.filters.procedure"),
      selected: filters.procedures,
      options: procedures.map(([id, title]) => ({ value: id, label: title, icon: <Workflow />, count: count("procedures", (row) => row.procedure === id) })),
      onToggle: (value, options) => pick({ procedures: toggle(filters.procedures, value) }, options),
    },
    {
      id: "environment",
      label: t("plans.home.filters.environment"),
      selected: filters.environments,
      options: environments.map((environment) => ({ value: environment, label: environment, icon: <Server />, count: count("environments", (row) => row.environment === environment) })),
      onToggle: (value, options) => pick({ environments: toggle(filters.environments, value) }, options),
    },
  ];
  return (
    <FilterBox
      query={filters.q}
      onQuery={(q) => update({ q })}
      groups={groups}
      placeholder={t("plans.home.filters.placeholder")}
      onClearAll={() => update(emptyFilters)}
    />
  );
}

function CardsView({ rows, base, search, q }: { rows: PlanRow[]; base: string; search: string; q: string }) {
  const { t } = useTranslation();
  const expert = useExpert();
  return (
    <CardGrid>
      {rows.map((row) => (
        <ResourceCard
          key={row.id}
          to={`${base}/${encodeURIComponent(row.id)}${search}`}
          marks={<><ModeBadge mode={row.mode} /><PlanStateBadges workState={row.workState} sessionState={row.sessionState} /></>}
          title={row.id}
          id={expert ? t("plans.home.card.id", { procedure: row.procedure, version: row.procedureVersion, revision: row.revision }) : row.procedure}
          note={matchReason(row, q)}
          facts={[
            { label: t("plans.home.card.environment"), value: <span className="mono">{row.environment}</span> },
            { label: t("plans.home.card.progress"), value: <ProgressBar satisfied={row.satisfied} total={row.total} /> },
          ]}
          footerLeft={<Link to={`/procedures/${encodeURIComponent(row.procedure)}`} className="flex min-w-0 items-center gap-1 text-label text-accent hover:underline"><Workflow size={12} className="shrink-0" /><span className="truncate-1">{row.procedureTitle}</span></Link>}
          footerRight={<span className="shrink-0">{relativeTime(row.createdAt)}</span>}
        />
      ))}
    </CardGrid>
  );
}

function ListView({ rows, base, search, q }: { rows: PlanRow[]; base: string; search: string; q: string }) {
  const { t } = useTranslation();
  const expert = useExpert();
  return (
    <ResourceTable
      columns={[
        { key: "plan", label: t("plans.home.list.plan"), width: "28%" },
        { key: "state", label: t("plans.home.list.state"), width: "12%" },
        { key: "procedure", label: t("plans.home.list.procedure") },
        { key: "environment", label: t("plans.home.list.environment"), width: "12%" },
        { key: "progress", label: t("plans.home.list.progress"), width: "14%" },
        { key: "engaged", label: t("plans.home.list.engaged"), width: "12%" },
      ]}
      rows={rows}
      rowKey={(row) => row.id}
      renderCells={(row) => [
        <TitleCell key="t" to={`${base}/${encodeURIComponent(row.id)}${search}`} title={row.id} id={expert ? t("plans.home.list.id", { revision: row.revision }) : ""} note={matchReason(row, q)} />,
        <span key="m" className="inline-flex flex-wrap items-center gap-1"><PlanStateBadges workState={row.workState} sessionState={row.sessionState} /></span>,
        <Link key="p" to={`/procedures/${encodeURIComponent(row.procedure)}`} className="text-body-lg text-accent hover:underline">{row.procedureTitle}{expert ? <span className="mono text-faint"> @{row.procedureVersion}</span> : null}</Link>,
        <span key="e" className="mono text-body">{row.environment}</span>,
        <ProgressBar key="g" satisfied={row.satisfied} total={row.total} />,
        <span key="d" className="text-body text-muted">{relativeTime(row.createdAt)}</span>,
      ]}
    />
  );
}
