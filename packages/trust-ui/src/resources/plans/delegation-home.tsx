import type { PlanSummaryView } from "@trust/extension-sdk";
import { ChevronDown, Circle } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useEnvironments, usePlan, usePlans } from "../../lib/runtime-context.js";
import { StatusBadge } from "../../ui/badge.js";
import { SearchInput } from "../../ui/controls.js";
import { CardGrid, ResourceCard } from "../shared/resource-card.js";
import { ResourceHome } from "../shared/resource-home.js";
import { useUrlFilters } from "../shared/use-url-filters.js";
import { DelegationDetail, useWorkDefinition } from "./delegation-detail.js";
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

interface Branch {
  plan: PlanSummaryView;
  children: Branch[];
}

function delegationBranches(plans: PlanSummaryView[], sort: Filters["sort"]): Branch[] {
  const children = new Map<string, PlanSummaryView[]>();
  for (const plan of plans) {
    if (!plan.parent) continue;
    const siblings = children.get(plan.parent.plan) ?? [];
    siblings.push(plan);
    children.set(plan.parent.plan, siblings);
  }
  const order = (a: PlanSummaryView, b: PlanSummaryView) =>
    sort === "name"
      ? (a.metadata.title ?? a.plan).localeCompare(b.metadata.title ?? b.plan)
      : b.createdAt.localeCompare(a.createdAt);
  const visit = (plan: PlanSummaryView, ancestors: Set<string>): Branch => ({
    plan,
    children: (children.get(plan.plan) ?? [])
      .filter((child) => !ancestors.has(child.plan))
      .sort(order)
      .map((child) => visit(child, new Set([...ancestors, child.plan]))),
  });
  const parents = new Set(children.keys());
  return plans
    .filter((plan) => parents.has(plan.plan) && (!plan.parent || !parents.has(plan.parent.plan)))
    .sort(order)
    .map((plan) => visit(plan, new Set([plan.plan])));
}

function matchingBranch(branch: Branch, query: string, workspaces: Map<string, string>): Branch | null {
  const { plan } = branch;
  const searchable = `${plan.metadata.title ?? ""} ${plan.plan} ${plan.procedure} ${plan.environment} ${workspaces.get(plan.environment) ?? ""}`;
  if (searchable.toLowerCase().includes(query)) return branch;
  const children = branch.children
    .map((child) => matchingBranch(child, query, workspaces))
    .filter((child): child is Branch => child !== null);
  return children.length ? { plan, children } : null;
}

export function DelegationHome() {
  const { t } = useTranslation();
  const catalog = usePlans();
  const environments = useEnvironments();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [filters, update] = useUrlFilters(read, write, "delegation");
  const plans = (catalog.data ?? []).filter((plan) => plan.mode === "live");
  const workspaces = new Map((environments.data ?? []).map(({ name, values }) => [name, values.workspaceRoot ?? ""]));
  // Only recorded parent-child relationships form roots; standalone Plans are not inferred delegations.
  const rows = delegationBranches(plans, filters.sort);
  const query = filters.q.trim().toLowerCase();
  const visible = query
    ? rows
        .map((branch) => matchingBranch(branch, query, workspaces))
        .filter((branch): branch is Branch => branch !== null)
    : rows;
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
  return (
    <div className="relative h-full">
      <ResourceHome
        crumbs={[{ label: "TRUST", to: "/overview" }, { label: t("delegation.title") }]}
        title={t("delegation.title")}
        subtitle={t("delegation.catalogSummary", {
          roots: String(rows.length),
          parents: String(plans.filter((plan) => plans.some((child) => child.parent?.plan === plan.plan)).length),
        })}
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
          listLabel: t("delegation.tree"),
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
          <DelegationTree branches={list} link={link} searching={!!query} workspaces={workspaces} />
        )}
        renderCards={(list) => (
          <CardGrid>
            {list.map(({ plan: row, children }) => (
              <ResourceCard
                key={row.plan}
                to={link(row.plan)}
                title={row.metadata.title ?? row.plan}
                id={row.plan}
                marks={<StatusBadge state={row.workState} />}
                facts={[{ label: t("delegation.children"), value: children.length }]}
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

function DelegationTree({
  branches,
  link,
  searching,
  workspaces,
}: {
  branches: Branch[];
  link: (id: string) => string;
  searching: boolean;
  workspaces: Map<string, string>;
}) {
  const { t } = useTranslation();
  return (
    <div className="bg-surface px-4 py-3">
      <h2 className="mb-3 text-caption font-semibold uppercase tracking-wide text-muted">{t("delegation.tree")}</h2>
      <ul className="space-y-3" aria-label={t("delegation.tree")}>
        {branches.map((branch) => (
          <DelegationTreeItem
            key={branch.plan.plan}
            branch={branch}
            link={link}
            searching={searching}
            workspaces={workspaces}
            root
          />
        ))}
      </ul>
    </div>
  );
}

function DelegationTreeItem({
  branch,
  link,
  searching,
  workspaces,
  root = false,
}: {
  branch: Branch;
  link: (id: string) => string;
  searching: boolean;
  workspaces: Map<string, string>;
  root?: boolean;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const groupId = useId();
  const { plan, children } = branch;
  const detail = usePlan(plan.plan);
  const definition = useWorkDefinition(plan.plan, detail.data);
  const title = plan.parent
    ? (definition?.title ?? plan.metadata.title ?? plan.procedure)
    : (plan.metadata.title ?? definition?.title ?? plan.procedure);
  const workspace = workspaces.get(plan.environment);
  const expanded = searching || !collapsed;
  return (
    <li data-delegation-plan={plan.plan}>
      <div className="flex min-h-14 items-center gap-2 rounded-(--radius-2) border border-border bg-surface px-3 py-2">
        {children.length ? (
          <button
            type="button"
            aria-label={t(expanded ? "delegation.collapseBranch" : "delegation.expandBranch", { name: title })}
            aria-expanded={expanded}
            aria-controls={groupId}
            onClick={() => setCollapsed(!collapsed)}
            className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-2) text-muted hover:bg-surface-2"
          >
            <ChevronDown size={16} className={expanded ? "" : "-rotate-90"} />
          </button>
        ) : (
          <span className="flex size-7 shrink-0 items-center justify-center text-faint">
            <Circle size={7} fill="currentColor" />
          </span>
        )}
        <Link to={link(plan.plan)} className="min-w-0 flex-1 hover:text-accent">
          <span className="block text-ui font-semibold">{title}</span>
          <span className="mono block truncate text-caption text-muted" title={plan.plan}>
            {plan.procedure}
            {plan.procedureVersion ? `@${plan.procedureVersion}` : ""}
          </span>
        </Link>
        {children.length > 0 && (
          <span className="text-caption text-muted">{t("delegation.childPlanCount", { count: children.length })}</span>
        )}
        <StatusBadge state={plan.workState} />
      </div>
      {root && (
        <div className="ml-10 flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5 text-caption text-muted">
          <Link to={`/environments/${encodeURIComponent(plan.environment)}`} className="hover:text-accent">
            {t("delegation.environment")}: <span className="mono">{plan.environment}</span>
          </Link>
          {workspace && (
            <span>
              {t("delegation.workspace")}: <span className="mono break-all text-text">{workspace}</span>
            </span>
          )}
        </div>
      )}
      {children.length > 0 && (
        <ul id={groupId} hidden={!expanded} className="ml-6 space-y-2 border-l border-border py-2 pl-4">
          {expanded &&
            children.map((child) => (
              <DelegationTreeItem
                key={child.plan.plan}
                branch={child}
                link={link}
                searching={searching}
                workspaces={workspaces}
              />
            ))}
        </ul>
      )}
    </li>
  );
}
