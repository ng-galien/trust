import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { usePlans } from "../../lib/runtime-context.js";
import { StatusBadge } from "../../ui/badge.js";
import { SearchInput } from "../../ui/controls.js";
import { CardGrid, ResourceCard } from "../shared/resource-card.js";
import { ResourceHome } from "../shared/resource-home.js";
import { ResourceTable, TitleCell } from "../shared/resource-table.js";
import { useUrlFilters } from "../shared/use-url-filters.js";
import { DelegationDetail } from "./delegation-detail.js";
import { ProgressBar } from "./parts.js";

interface Filters {
  q: string;
  view: "cards" | "list";
  group: "none";
  sort: "name" | "recent";
}
const read = (params: URLSearchParams): Filters => ({
  q: params.get("q") ?? "",
  view: params.get("view") === "cards" ? "cards" : "list",
  group: "none",
  sort: params.get("sort") === "name" ? "name" : "recent",
});
const write = (filters: Filters, base: URLSearchParams) => {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(filters)) next.set(key, value);
  return next;
};

export function DelegationHome() {
  const { t } = useTranslation();
  const catalog = usePlans();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [filters, update] = useUrlFilters(read, write, "delegation");
  const plans = (catalog.data ?? []).filter((plan) => plan.mode === "live");
  const parents = new Set(plans.flatMap((plan) => (plan.parent ? [plan.parent.plan] : [])));
  // A catalog row is a recorded delegation parent, never an unrelated standalone Plan.
  const rows = plans.filter((plan) => parents.has(plan.plan));
  const visible = rows
    .filter((plan) =>
      `${plan.metadata.title ?? ""} ${plan.plan} ${plan.environment}`.toLowerCase().includes(filters.q.toLowerCase()),
    )
    .sort((a, b) =>
      filters.sort === "name"
        ? (a.metadata.title ?? a.plan).localeCompare(b.metadata.title ?? b.plan)
        : b.createdAt.localeCompare(a.createdAt),
    );
  const selected = params.get("plan");
  const link = (id: string) => {
    const next = new URLSearchParams(location.search);
    next.set("plan", id);
    return `/delegation?${next}`;
  };
  const close = () => {
    const next = new URLSearchParams(location.search);
    next.delete("plan");
    next.delete("tab");
    navigate(`/delegation?${next}`);
  };
  const children = (id: string) => plans.filter((plan) => plan.parent?.plan === id).length;
  return (
    <div className="relative h-full">
      <ResourceHome
        crumbs={[{ label: "TRUST", to: "/overview" }, { label: t("delegation.title") }]}
        title={t("delegation.title")}
        subtitle={t("delegation.catalogSummary")}
        total={rows.length}
        visible={visible.length}
        loading={catalog.isLoading}
        error={catalog.error?.message}
        emptyTitle={t("delegation.noBranches")}
        onClearFilters={() => update({ q: "" })}
        filterBox={
          <SearchInput value={filters.q} onChange={(q) => update({ q })} placeholder={t("delegation.search")} />
        }
        display={{
          view: filters.view,
          onView: (view) => update({ view }),
          group: "none",
          onGroup: () => {},
          groupOptions: [{ value: "none", label: t("templates.ungrouped") }],
          sort: filters.sort,
          onSort: (sort) => update({ sort }),
          sortOptions: [
            { value: "recent", label: t("delegation.recent") },
            { value: "name", label: t("templates.name") },
          ],
        }}
        groups={[{ key: "all", label: "", rows: visible }]}
        overlayOpen={!!selected}
        renderList={(list) => (
          <ResourceTable
            columns={[
              { key: "work", label: t("delegation.work"), width: "45%" },
              { key: "environment", label: t("delegation.environment") },
              { key: "children", label: t("delegation.children") },
              { key: "state", label: t("delegation.state") },
            ]}
            rows={list}
            rowKey={(row) => row.plan}
            renderCells={(row) => [
              <TitleCell key="work" to={link(row.plan)} title={row.metadata.title ?? row.plan} id={row.plan} />,
              <span key="env">{row.environment}</span>,
              <span key="children">{children(row.plan)}</span>,
              <StatusBadge key="state" state={row.workState} />,
            ]}
          />
        )}
        renderCards={(list) => (
          <CardGrid>
            {list.map((row) => (
              <ResourceCard
                key={row.plan}
                to={link(row.plan)}
                title={row.metadata.title ?? row.plan}
                id={row.plan}
                marks={<StatusBadge state={row.workState} />}
                facts={[{ label: t("delegation.children"), value: children(row.plan) }]}
                footerLeft={row.environment}
                footerRight={<ProgressBar satisfied={row.satisfiedChecks} total={row.checkCount} />}
              />
            ))}
          </CardGrid>
        )}
      />
      {selected && <DelegationDetail key={selected} selected={selected} plans={plans} onClose={close} />}
    </div>
  );
}
