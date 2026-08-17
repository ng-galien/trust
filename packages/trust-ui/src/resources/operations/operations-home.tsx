import { CircleSlash, FileText, GitBranch, Globe, PlayCircle, Terminal } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";

import { useCurrentEnvironment } from "../../lib/environment.js";
import { cx, plural } from "../../lib/format.js";
import { useOperationEnvironments, useOperations, useProcedures } from "../../lib/runtime-context.js";
import { type FacetGroupSpec, FilterBox } from "../../ui/filter-box.js";
import { Popover } from "../../ui/menu.js";
import { facetHelpers } from "../shared/facets.js";
import { CardGrid, NameList, ResourceCard } from "../shared/resource-card.js";
import { ResourceHome } from "../shared/resource-home.js";
import { ResourceTable, TitleCell } from "../shared/resource-table.js";
import { useUrlFilters } from "../shared/use-url-filters.js";
import { families, type Nature, natureLabel, otherFamily } from "./classification.js";
import { applyFacets, applyFilters, emptyFilters, type Filters, groupRows, matchReason, type OperationRow, readFilters, type StepType, stepTypeLabel, toRows, writeFilters } from "./model.js";

export function OperationsHome() {
  const { t } = useTranslation();
  const operations = useOperations();
  const procedures = useProcedures();
  const operationEnvironments = useOperationEnvironments();
  const location = useLocation();
  const [filters, update] = useUrlFilters(readFilters, writeFilters, "operations");
  const overlayOpen = location.pathname !== "/operations" && location.pathname !== "/operations/";

  const rows = useMemo(() => toRows(operations.data ?? [], procedures.data ?? [], operationEnvironments.data), [operations.data, procedures.data, operationEnvironments.data]);
  const visible = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const groups = useMemo(() => groupRows(visible, filters.group), [visible, filters.group]);

  return (
    <ResourceHome
      crumbs={[{ label: "TRUST", to: "/overview" }, { label: t("operations.home.title") }]}
      title={t("operations.home.title")}
      total={rows.length}
      visible={visible.length}
      createTo={`/operations/new${location.search}`}
      createLabel={t("operations.home.create")}
      filterBox={<OperationFilters rows={rows} filters={filters} update={update} />}
      display={{
        view: filters.view,
        onView: (view) => update({ view }),
        group: filters.group,
        groupOptions: [{ value: "none", label: t("operations.home.group.none") }, { value: "domain", label: t("operations.home.group.domain") }, { value: "family", label: t("operations.home.group.family") }],
        onGroup: (group) => update({ group }),
        sort: filters.sort,
        sortOptions: [{ value: "name", label: t("operations.home.sort.name") }, { value: "version", label: t("operations.home.sort.version") }, { value: "steps", label: t("operations.home.sort.steps") }, { value: "usage", label: t("operations.home.sort.usage") }],
        onSort: (sort) => update({ sort }),
      }}
      loading={operations.isLoading}
      error={operations.error?.message}
      emptyTitle={rows.length ? t("operations.home.emptyFilteredTitle") : t("operations.home.emptyCatalogTitle")}
      emptyBody={rows.length ? t("operations.home.emptyFilteredBody") : t("operations.home.emptyCatalogBody")}
      onClearFilters={() => update(emptyFilters)}
      groups={groups}
      renderCards={(list) => <CardsView rows={list} search={location.search} q={filters.q} />}
      renderList={(list) => <ListView rows={list} search={location.search} q={filters.q} />}
      overlayOpen={overlayOpen}
    />
  );
}

/* ------------------------------------------------------------------ facets */

function OperationFilters({ rows, filters, update }: { rows: OperationRow[]; filters: Filters; update: (patch: Partial<Filters>) => void }) {
  const { t } = useTranslation();
  const { count, toggle, pick } = facetHelpers(rows, filters, applyFacets, update);
  const familyIds = Array.from(new Set(rows.map((row) => row.family.id)));
  const groups: FacetGroupSpec[] = [
    {
      id: "family",
      label: t("operations.home.facets.family"),
      exclusive: true,
      selected: filters.family ? [filters.family] : [],
      options: [...families, otherFamily]
        .filter((family) => familyIds.includes(family.id))
        .map((family) => ({ value: family.id, label: family.label, count: count("family", (row) => row.family.id === family.id) })),
      onToggle: (value, options) => pick({ family: filters.family === value ? "" : value, domains: [] }, options),
    },
    {
      id: "domain",
      label: t("operations.home.facets.domain"),
      selected: filters.domains,
      options: Array.from(new Set(rows.filter((row) => !filters.family || row.family.id === filters.family).map((row) => row.domain).filter(Boolean)))
        .sort()
        .map((domain) => ({ value: domain, label: domain, count: count("domains", (row) => row.domain === domain) })),
      onToggle: (value, options) => pick({ domains: toggle(filters.domains, value) }, options),
    },
    {
      id: "action",
      label: t("operations.home.facets.action"),
      selected: filters.types,
      options: (["shell", "http", "file-read"] as StepType[]).map((type) => ({ value: type, label: stepTypeLabel(type), icon: <StepTypeIcon type={type} />, count: count("types", (row) => row.stepTypes.includes(type)) })),
      onToggle: (value, options) => pick({ types: toggle(filters.types, value as StepType) }, options),
    },
    {
      id: "nature",
      label: t("operations.home.facets.nature"),
      exclusive: true,
      selected: filters.nature ? [filters.nature] : [],
      options: (["observe", "act"] as Nature[]).map((nature) => ({ value: nature, label: natureLabel(nature), count: count("nature", (row) => row.nature === nature) })),
      onToggle: (value, options) => pick({ nature: filters.nature === value ? "" : (value as Nature) }, options),
    },
    {
      id: "usage",
      label: t("operations.home.facets.usage"),
      exclusive: true,
      selected: filters.usage ? [filters.usage] : [],
      options: [
        { value: "used", label: t("operations.home.facets.usedByProcedure"), count: count("usage", (row) => row.usedBy.length > 0) },
        { value: "unused", label: t("operations.home.facets.notUsedYet"), count: count("usage", (row) => row.usedBy.length === 0) },
      ],
      onToggle: (value, options) => pick({ usage: filters.usage === value ? "" : (value as "used" | "unused") }, options),
    },
    {
      id: "runnable",
      label: t("operations.home.facets.runnable"),
      exclusive: true,
      selected: filters.runnable ? [filters.runnable] : [],
      options: [
        { value: "yes", label: t("operations.home.facets.hasEnvironment"), count: count("runnable", (row) => (row.runnableOn?.length ?? 0) > 0) },
        { value: "no", label: t("operations.home.facets.noEnvironment"), count: count("runnable", (row) => (row.runnableOn?.length ?? 0) === 0) },
      ],
      onToggle: (value, options) => pick({ runnable: filters.runnable === value ? "" : (value as "yes" | "no") }, options),
    },
  ];

  return (
    <FilterBox
      query={filters.q}
      onQuery={(q) => update({ q })}
      groups={groups}
      placeholder={t("operations.home.searchPlaceholder")}
      onClearAll={() => update(emptyFilters)}
    />
  );
}

function StepTypeIcon({ type, size = 12, className }: { type: StepType; size?: number; className?: string }) {
  const Icon = type === "shell" ? Terminal : type === "http" ? Globe : FileText;
  return <Icon size={size} className={className} aria-hidden />;
}

export function StepTypeMark({ type, withLabel = true, className }: { type: StepType; withLabel?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-(--radius-1) bg-surface-3 px-1.5 py-0.5 text-caption font-medium text-text", className)} title={stepTypeLabel(type)}>
      <StepTypeIcon type={type} className="text-muted" />
      {withLabel ? stepTypeLabel(type) : null}
    </span>
  );
}

/** Server-computed runnability, read against the current environment: runnable here / elsewhere only / nowhere. */
export function RunnableMark({ environments, compact = false }: { environments: string[] | undefined; compact?: boolean }) {
  const { t } = useTranslation();
  const current = useCurrentEnvironment().name;
  if (environments === undefined) return <span className="text-meta text-faint">…</span>;
  if (environments.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-(--radius-1) border border-warning/40 bg-warning-soft px-1.5 py-0.5 text-meta font-medium text-warning" title={t("operations.home.runnable.noEnvironmentHint")}>
        <CircleSlash size={11} /> {t("operations.home.runnable.noEnvironment")}
      </span>
    );
  }
  if (current !== null && !environments.includes(current)) {
    return (
      <span className="inline-flex items-center gap-1 rounded-(--radius-1) border border-warning/40 bg-warning-soft px-1.5 py-0.5 text-meta font-medium text-warning" title={t("operations.home.runnable.notOnCurrentHint", { current, names: environments.join(", ") })}>
        <CircleSlash size={11} /> {compact ? environments.length : t("operations.home.runnable.notOnCurrent", { current })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-(--radius-1) border border-success/30 bg-success-soft px-1.5 py-0.5 text-meta font-medium text-success" title={current ? t("operations.home.runnable.onCurrentHint", { current }) : t("operations.home.runnable.runnableOn", { names: environments.join(", ") })}>
      <PlayCircle size={11} /> {compact ? environments.length : current ? t("operations.home.runnable.onCurrent") : t("operations.home.runnable.runnableList", { names: environments.length <= 2 ? environments.join(", ") : t("operations.home.runnable.envCount", { count: environments.length }) })}
    </span>
  );
}

function CardsView({ rows, search, q }: { rows: OperationRow[]; search: string; q: string }) {
  const { t } = useTranslation();
  return (
    <CardGrid>
      {rows.map((row) => (
        <ResourceCard
          key={row.id}
          to={`/operations/${encodeURIComponent(row.id)}${search}`}
          marks={<>{row.stepTypes.map((type) => <StepTypeMark key={type} type={type} />)}{row.domain ? <span className="text-caption text-muted">· {row.domain}</span> : null}</>}
          version={row.operation.version}
          title={row.operation.title}
          description={row.operation.description}
          id={row.id}
          note={matchReason(row, q) ? t("operations.home.matches", { reason: matchReason(row, q) ?? "" }) : undefined}
          facts={[
            { label: t("operations.home.needs"), value: <NameList names={[...row.inputs, ...row.environment]} /> },
            { label: t("operations.home.produces"), value: <NameList names={row.produced} /> },
          ]}
          footerLeft={
            <span className="inline-flex items-center gap-1.5">
              <GitBranch size={12} className={row.usedBy.length ? "text-accent" : "text-faint"} />
              {row.usedBy.length ? t("operations.home.usedByProcedures", { procedures: plural(row.usedBy.length, "procedure") }) : t("operations.home.notUsedYet")}
            </span>
          }
          footerRight={<span data-doc="operations.runnable"><RunnableMark environments={row.runnableOn} /></span>}
        />
      ))}
    </CardGrid>
  );
}

function ListView({ rows, search, q }: { rows: OperationRow[]; search: string; q: string }) {
  const { t } = useTranslation();
  return (
    <ResourceTable
      columns={[
        { key: "operation", label: t("operations.home.columns.operation"), width: "30%" },
        { key: "interface", label: t("operations.home.columns.interface") },
        { key: "usedBy", label: t("operations.home.columns.usedBy"), width: "16%" },
        { key: "runnable", label: t("operations.home.columns.runnableOn"), width: "14%" },
      ]}
      rows={rows}
      rowKey={(row) => row.id}
      renderCells={(row) => [
        <TitleCell key="t" to={`/operations/${encodeURIComponent(row.id)}${search}`} title={row.operation.title} id={row.id} version={row.operation.version} description={row.operation.description} note={matchReason(row, q) ? t("operations.home.matches", { reason: matchReason(row, q) ?? "" }) : undefined} />,
        <div key="i" className="flex flex-col gap-1">
          <span className="flex items-center gap-1">
            {row.stepTypes.map((type) => (
              <StepTypeMark key={type} type={type} />
            ))}
            <span className="text-caption text-faint">{plural(row.operation.steps.length, "step")}</span>
          </span>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-body leading-snug">
            <dt className="text-faint">{t("operations.home.needs")}</dt>
            <dd className="break-words"><NameList names={[...row.inputs, ...row.environment]} max={4} /></dd>
            <dt className="text-faint">{t("operations.home.produces")}</dt>
            <dd className="break-words"><NameList names={row.produced} max={4} /></dd>
          </dl>
        </div>,
        <div key="u" className="text-body"><ProcedureLinks procedures={row.usedBy} /></div>,
        <div key="r" className="text-body"><EnvironmentLinks environments={row.runnableOn} /></div>,
      ]}
    />
  );
}

/** Procedures using an operation, as links (the resource pages own the details). */
function ProcedureLinks({ procedures }: { procedures: OperationRow["usedBy"] }) {
  const { t } = useTranslation();
  if (procedures.length === 0) return <span className="text-faint">{t("operations.home.notUsedYet")}</span>;
  const shown = procedures.slice(0, 2);
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map(({ procedure }) => (
        <Link key={`${procedure.procedure}@${procedure.version}`} to={`/procedures/${encodeURIComponent(procedure.procedure)}`} className="mono inline-flex items-center gap-1 truncate-1 text-accent hover:underline" title={t("operations.home.procedureTitle", { title: procedure.title, version: procedure.version })}>
          <GitBranch size={11} className="shrink-0" /> {procedure.procedure}
        </Link>
      ))}
      {procedures.length > shown.length ? (
        <Popover
          align="start"
          panelClassName="min-w-56 p-1"
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} className="text-left text-label text-muted hover:text-text">{t("operations.home.more", { count: procedures.length - shown.length })}</button>
          )}
        >
          {procedures.slice(shown.length).map(({ procedure }) => (
            <Link key={`${procedure.procedure}@${procedure.version}`} to={`/procedures/${encodeURIComponent(procedure.procedure)}`} className="mono flex items-center gap-1 rounded-(--radius-1) px-2 py-1 text-body hover:bg-surface-2">
              <GitBranch size={11} className="text-muted" /> {procedure.procedure} <span className="ml-auto text-faint">{t("operations.home.version", { version: procedure.version })}</span>
            </Link>
          ))}
        </Popover>
      ) : null}
    </div>
  );
}

/** Environments able to run the operation; each will link to its Environment page once that resource exists. */
function EnvironmentLinks({ environments }: { environments: string[] | undefined }) {
  const { t } = useTranslation();
  const current = useCurrentEnvironment().name;
  if (environments === undefined) return <span className="text-faint">…</span>;
  if (environments.length === 0) return <RunnableMark environments={environments} />;
  return (
    <div className="flex flex-wrap gap-1">
      {environments.map((name) => (
        <span key={name} className={cx("mono inline-flex h-5 items-center rounded-(--radius-1) border px-1.5 text-caption", name === current ? "border-success bg-success-soft font-semibold text-success" : "border-border bg-surface-2 text-muted")} title={name === current ? t("operations.home.runnable.onCurrentHint", { current }) : t("operations.home.runnable.runnableOn", { names: name })}>
          {name}
        </span>
      ))}
    </div>
  );
}
