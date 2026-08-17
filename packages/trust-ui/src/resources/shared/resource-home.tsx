import { ChevronDown, LayoutGrid, List, Plus, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet } from "react-router";

import { cx } from "../../lib/format.js";
import { Breadcrumb, type Crumb } from "../../ui/breadcrumb.js";
import { Button } from "../../ui/button.js";
import { SegmentedControl } from "../../ui/controls.js";
import { OptionRow, Popover } from "../../ui/menu.js";
import { EmptyState, ErrorBox, LoadingState } from "../../ui/states.js";

/* The home of one resource type: header, filter row, grouped Cards or List, item overlay outlet.
   Every resource instantiates this so lists behave the same everywhere. */

type ViewMode = "cards" | "list";

interface DisplayOption<T extends string> { value: T; label: string }

export interface DisplayState<G extends string, S extends string> {
  view: ViewMode;
  onView: (view: ViewMode) => void;
  group: G;
  groupOptions: Array<DisplayOption<G>>;
  onGroup: (group: G) => void;
  sort: S;
  sortOptions: Array<DisplayOption<S>>;
  onSort: (sort: S) => void;
}

export interface ResourceGroup<Row> { key: string; label: string; rows: Row[] }

export function ResourceHome<Row, G extends string, S extends string>({
  crumbs,
  title,
  subtitle,
  total,
  visible,
  createTo,
  createLabel,
  filterBox,
  display,
  loading,
  error,
  emptyTitle,
  emptyBody,
  onClearFilters,
  groups,
  renderCards,
  renderList,
  footer,
  overlayOpen,
}: {
  crumbs: Crumb[];
  title: string;
  /** One short factual line under the title (never explanatory prose). */
  subtitle?: string;
  total: number;
  visible: number;
  createTo?: string;
  createLabel?: string;
  filterBox: ReactNode;
  display: DisplayState<G, S>;
  loading: boolean;
  error?: string | undefined;
  emptyTitle: string;
  /** One short factual sentence at most (never explanatory prose). */
  emptyBody?: string | undefined;
  onClearFilters?: () => void;
  groups: Array<ResourceGroup<Row>>;
  renderCards: (rows: Row[]) => ReactNode;
  renderList: (rows: Row[]) => ReactNode;
  /** Rendered after the groups (e.g. a "Load more" control for paginated lists). */
  footer?: ReactNode;
  overlayOpen: boolean;
}) {
  const { t } = useTranslation();
  const filtered = visible !== total;
  return (
    <div className="relative h-full">
      <div className="flex h-full flex-col overflow-hidden" inert={overlayOpen || undefined} aria-hidden={overlayOpen || undefined}>
        <div className="shrink-0 border-b border-border bg-surface px-6 pt-4 pb-3" data-doc="home.header">
          <Breadcrumb items={crumbs} className="mb-2" />
          <div className="flex items-end justify-between gap-6">
            <div>
              <h1 className="flex items-center gap-2 text-heading font-semibold tracking-tight">
                {title}
                <span className="text-lead font-normal text-muted">· {filtered ? t("shared.resourceHome.visibleOfTotal", { visible: String(visible), total: String(total) }) : total}</span>
              </h1>
              {subtitle ? <p className="mt-0.5 text-body-lg text-muted">{subtitle}</p> : null}
            </div>
            {createTo ? (
              <Link to={createTo} data-doc="home.create" className="inline-flex h-8 items-center gap-1.5 rounded-(--radius-2) bg-accent px-3 text-ui font-medium text-accent-contrast hover:bg-accent-hover">
                <Plus size={15} /> {createLabel ?? t("common.actions.new")}
              </Link>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-6 py-2.5">
          <div className="min-w-[420px] flex-1" data-doc="home.filters">{filterBox}</div>
          <span data-doc="home.display"><DisplayMenu display={display} /></span>
        </div>

        <div className={cx("min-h-0 flex-1 overflow-y-auto", display.view === "cards" ? "px-6 py-4" : "")} data-doc="home.content">
          {loading ? <LoadingState /> : null}
          {error ? <div className="p-4"><ErrorBox message={error} /></div> : null}
          {!loading && !error && visible === 0 ? (
            <div className={display.view === "cards" ? "" : "p-6"}>
              <EmptyState title={emptyTitle} {...(emptyBody ? { body: emptyBody } : {})} action={filtered && onClearFilters ? <Button size="sm" onClick={onClearFilters}>{t("common.actions.clearFilters")}</Button> : undefined} />
            </div>
          ) : null}
          {groups.map((group) => (
            <section key={group.key} className={display.view === "cards" ? "mb-6 last:mb-0" : ""}>
              {group.label ? (
                <h2 className={cx("flex items-center gap-2 text-ui font-semibold", display.view === "cards" ? "mb-2" : "border-b border-border bg-surface-2 px-4 py-1.5")}>
                  {group.label}
                  <span className="text-label font-normal text-muted">{group.rows.length}</span>
                </h2>
              ) : null}
              {display.view === "cards" ? renderCards(group.rows) : renderList(group.rows)}
            </section>
          ))}
          {footer}
        </div>
      </div>
      <Outlet />
    </div>
  );
}

function DisplayMenu<G extends string, S extends string>({ display }: { display: DisplayState<G, S> }) {
  const { t } = useTranslation();
  const groupLabel = display.groupOptions.find((option) => option.value === display.group)?.label;
  const sortLabel = display.sortOptions.find((option) => option.value === display.sort)?.label;
  const defaultGroup = display.groupOptions[0]?.value;
  const defaultSort = display.sortOptions[0]?.value;
  return (
    <Popover
      panelClassName="w-64 p-1.5"
      trigger={({ open, toggle }) => (
        <Button icon={<SlidersHorizontal size={14} />} onClick={toggle} aria-expanded={open} className={cx(open && "bg-surface-2")}>
          {t("shared.resourceHome.display")}
          <span className="ml-1 text-caption font-normal text-muted">
            {display.view === "cards" ? t("shared.resourceHome.cards") : t("shared.resourceHome.list")}
            {display.group !== defaultGroup && groupLabel ? ` · ${t("shared.resourceHome.byGroup", { group: groupLabel.toLowerCase() })}` : ""}
            {display.sort !== defaultSort && sortLabel ? ` · ${sortLabel.toLowerCase()}` : ""}
          </span>
          <ChevronDown size={12} className={cx("text-muted transition-transform", open && "rotate-180")} />
        </Button>
      )}
    >
      <DisplaySection title={t("shared.resourceHome.view")}>
        <div className="px-1 pb-1">
          <SegmentedControl
            ariaLabel={t("shared.resourceHome.viewMode")}
            size="sm"
            value={display.view}
            onChange={display.onView}
            options={[
              { value: "cards", label: <><LayoutGrid size={13} /> {t("shared.resourceHome.cards")}</> },
              { value: "list", label: <><List size={13} /> {t("shared.resourceHome.list")}</> },
            ]}
          />
        </div>
      </DisplaySection>
      {display.groupOptions.length > 1 ? (
        <DisplaySection title={t("shared.resourceHome.groupBy")}>
          {display.groupOptions.map((option) => (
            <OptionRow key={option.value} active={display.group === option.value} onSelect={() => display.onGroup(option.value)}>{option.label}</OptionRow>
          ))}
        </DisplaySection>
      ) : null}
      <DisplaySection title={t("shared.resourceHome.sortBy")}>
        {display.sortOptions.map((option) => (
          <OptionRow key={option.value} active={display.sort === option.value} onSelect={() => display.onSort(option.value)}>{option.label}</OptionRow>
        ))}
      </DisplaySection>
    </Popover>
  );
}

function DisplaySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border py-1 last:border-b-0">
      <h4 className="kicker px-2 pt-1 pb-1">{title}</h4>
      {children}
    </section>
  );
}
