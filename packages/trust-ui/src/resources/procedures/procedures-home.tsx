import { Activity, ListChecks, TerminalSquare } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";

import { plural, relativeTime } from "../../lib/format.js";
import { usePlans, useProcedures } from "../../lib/runtime-context.js";
import { Badge } from "../../ui/badge.js";
import { type FacetGroupSpec, FilterBox } from "../../ui/filter-box.js";
import { families, otherFamily } from "../operations/classification.js";
import { facetHelpers } from "../shared/facets.js";
import { CardGrid, NameList, ResourceCard } from "../shared/resource-card.js";
import { ResourceHome } from "../shared/resource-home.js";
import { ResourceTable, TitleCell } from "../shared/resource-table.js";
import { useUrlFilters } from "../shared/use-url-filters.js";
import { applyFacets, applyFilters, emptyFilters, type Filters, groupRows, matchReason, type ProcedureRow, readFilters, toRows, writeFilters } from "./model.js";

export function ProceduresHome() {
  const procedures = useProcedures();
  const plans = usePlans();
  const location = useLocation();
  const { t } = useTranslation();
  const [filters, update] = useUrlFilters(readFilters, writeFilters, "procedures");
  const overlayOpen = location.pathname !== "/procedures" && location.pathname !== "/procedures/";

  const rows = useMemo(() => toRows(procedures.data ?? [], plans.data ?? []), [procedures.data, plans.data]);
  const visible = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const groups = useMemo(() => groupRows(visible, filters.group), [visible, filters.group]);

  return (
    <ResourceHome
      crumbs={[{ label: t("procedures.crumbRoot"), to: "/overview" }, { label: t("procedures.crumbProcedures") }]}
      title={t("procedures.home.title")}
      total={rows.length}
      visible={visible.length}
      createTo={`/procedures/new${location.search}`}
      createLabel={t("procedures.home.create")}
      filterBox={<ProcedureFilters rows={rows} filters={filters} update={update} />}
      display={{
        view: filters.view,
        onView: (view) => update({ view }),
        group: filters.group,
        groupOptions: [{ value: "none", label: t("procedures.home.group.none") }, { value: "family", label: t("procedures.home.group.family") }],
        onGroup: (group) => update({ group }),
        sort: filters.sort,
        sortOptions: [{ value: "name", label: t("procedures.home.sort.name") }, { value: "published", label: t("procedures.home.sort.published") }, { value: "checks", label: t("procedures.home.sort.checks") }, { value: "plans", label: t("procedures.home.sort.plans") }],
        onSort: (sort) => update({ sort }),
      }}
      loading={procedures.isLoading}
      error={procedures.error?.message}
      emptyTitle={rows.length ? t("procedures.home.emptyFilteredTitle") : t("procedures.home.emptyTitle")}
      emptyBody={rows.length ? t("procedures.home.emptyFilteredBody") : t("procedures.home.emptyBody")}
      onClearFilters={() => update(emptyFilters)}
      groups={groups}
      renderCards={(list) => <CardsView rows={list} search={location.search} q={filters.q} />}
      renderList={(list) => <ListView rows={list} search={location.search} q={filters.q} />}
      overlayOpen={overlayOpen}
    />
  );
}

function ProcedureFilters({ rows, filters, update }: { rows: ProcedureRow[]; filters: Filters; update: (patch: Partial<Filters>) => void }) {
  const { t } = useTranslation();
  const { count, toggle, pick } = facetHelpers(rows, filters, applyFacets, update);
  const familyIds = Array.from(new Set(rows.map((row) => row.family.id)));
  const operationIds = Array.from(new Set(rows.flatMap((row) => row.operations))).sort();
  const groups: FacetGroupSpec[] = [
    {
      id: "family",
      label: t("procedures.home.facets.family"),
      exclusive: true,
      selected: filters.family ? [filters.family] : [],
      options: [...families, otherFamily].filter((family) => familyIds.includes(family.id)).map((family) => ({ value: family.id, label: family.label, count: count("family", (row) => row.family.id === family.id) })),
      onToggle: (value, options) => pick({ family: filters.family === value ? "" : value }, options),
    },
    {
      id: "operation",
      label: t("procedures.home.facets.uses"),
      selected: filters.operations,
      options: operationIds.map((operation) => ({ value: operation, label: operation, icon: <TerminalSquare />, count: count("operations", (row) => row.operations.includes(operation)) })),
      onToggle: (value, options) => pick({ operations: toggle(filters.operations, value) }, options),
    },
    {
      id: "plans",
      label: t("procedures.home.facets.plans"),
      exclusive: true,
      selected: filters.plans ? [filters.plans] : [],
      options: [
        { value: "active", label: t("procedures.home.facets.runningNow"), count: count("plans", (row) => row.activePlans.length > 0) },
        { value: "any", label: t("procedures.home.facets.executedOnce"), count: count("plans", (row) => row.plans.length > 0) },
        { value: "none", label: t("procedures.home.facets.neverExecuted"), count: count("plans", (row) => row.plans.length === 0) },
      ],
      onToggle: (value, options) => pick({ plans: filters.plans === value ? "" : (value as Filters["plans"]) }, options),
    },
  ];
  return (
    <FilterBox
      query={filters.q}
      onQuery={(q) => update({ q })}
      groups={groups}
      placeholder={t("procedures.home.searchPlaceholder")}
      onClearAll={() => update(emptyFilters)}
    />
  );
}

export function PlansMark({ plans, active }: { plans: number; active: number }) {
  const { t } = useTranslation();
  if (plans === 0) return <span className="inline-flex items-center gap-1 text-label text-faint"><Activity size={12} /> {t("procedures.home.plansMark.never")}</span>;
  return (
    <span className={active ? "inline-flex items-center gap-1 rounded-(--radius-1) border border-info/30 bg-info-soft px-1.5 py-0.5 text-meta font-medium text-info" : "inline-flex items-center gap-1 text-label text-muted"}>
      <Activity size={11} className={active ? "animate-pulse" : ""} />
      {active ? t("procedures.home.plansMark.running", { active: String(active), count: plans }) : plural(plans, "plan")}
    </span>
  );
}

function CardsView({ rows, search, q }: { rows: ProcedureRow[]; search: string; q: string }) {
  const { t } = useTranslation();
  return (
    <CardGrid>
      {rows.map((row) => (
        <ResourceCard
          key={`${row.id}@${row.version}`}
          to={`/procedures/${encodeURIComponent(row.id)}${search}`}
          marks={
            <>
              <Badge tone="success">{t("procedures.home.published")}</Badge>
              <span className="inline-flex items-center gap-1 text-caption text-muted"><ListChecks size={12} /> {t("procedures.home.scenAbbrev", { count: row.scenarioCount })} · {plural(row.checkCount, "check")}</span>
            </>
          }
          version={row.version}
          title={row.title}
          description={row.description}
          id={row.id}
          note={matchReason(row, q)}
          facts={[
            { label: t("procedures.home.needs"), value: <NameList names={row.inputs} /> },
            { label: t("procedures.home.uses"), value: <NameList names={row.operations} /> },
          ]}
          footerLeft={<PlansMark plans={row.plans.length} active={row.activePlans.length} />}
          footerRight={<span title={row.publishedBy}>{relativeTime(row.publishedAt)}</span>}
        />
      ))}
    </CardGrid>
  );
}

function ListView({ rows, search, q }: { rows: ProcedureRow[]; search: string; q: string }) {
  const { t } = useTranslation();
  return (
    <ResourceTable
      columns={[
        { key: "procedure", label: t("procedures.home.columns.procedure"), width: "30%" },
        { key: "structure", label: t("procedures.home.columns.structure") },
        { key: "plans", label: t("procedures.home.columns.plans"), width: "18%" },
        { key: "published", label: t("procedures.home.columns.published"), width: "14%" },
      ]}
      rows={rows}
      rowKey={(row) => `${row.id}@${row.version}`}
      renderCells={(row) => [
        <TitleCell key="t" to={`/procedures/${encodeURIComponent(row.id)}${search}`} title={row.title} id={row.id} version={row.version} description={row.description} note={matchReason(row, q)} />,
        <div key="s" className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-caption text-muted"><ListChecks size={12} /> {plural(row.scenarioCount, "scenario")} · {plural(row.checkCount, "check")}</span>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-body leading-snug">
            <dt className="text-faint">{t("procedures.home.needs")}</dt>
            <dd className="break-words"><NameList names={row.inputs} max={4} /></dd>
            <dt className="text-faint">{t("procedures.home.uses")}</dt>
            <dd className="break-words">
              {row.operations.length ? row.operations.slice(0, 4).map((operation, index) => (
                <span key={operation}>
                  {index > 0 ? ", " : ""}
                  <Link to={`/operations/${encodeURIComponent(operation)}`} className="mono text-accent hover:underline">{operation}</Link>
                </span>
              )) : <span className="text-faint">—</span>}
              {row.operations.length > 4 ? <span className="text-faint"> +{row.operations.length - 4}</span> : null}
            </dd>
          </dl>
        </div>,
        <div key="p" className="flex flex-col gap-0.5 text-body">
          {row.plans.length === 0 ? <PlansMark plans={0} active={0} /> : null}
          {[...row.activePlans, ...row.plans.filter((plan) => plan.workState !== "IN_PROGRESS")].slice(0, 3).map((plan) => (
            <Link key={plan.plan} to={`/plans/${encodeURIComponent(plan.plan)}`} className="mono inline-flex items-center gap-1 truncate-1 text-accent hover:underline" title={t("procedures.home.planLinkTitle", { state: plan.workState.replace("_", " "), satisfied: String(plan.satisfiedChecks), total: String(plan.checkCount) })}>
              <span className={plan.workState === "IN_PROGRESS" ? "h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-info" : "h-1.5 w-1.5 shrink-0 rounded-full bg-success"} />
              {plan.plan}
            </Link>
          ))}
          {row.plans.length > 3 ? <span className="text-caption text-faint">{t("procedures.home.more", { count: row.plans.length - 3 })}</span> : null}
        </div>,
        <div key="d" className="text-body text-muted" title={row.publishedAt}>
          <span className="block">{relativeTime(row.publishedAt)}</span>
          <span className="block truncate-1 text-caption text-faint" title={row.publishedBy}>{row.publishedBy.replace(/^urn:trust:/, "")}</span>
        </div>,
      ]}
    />
  );
}


