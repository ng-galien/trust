import { useQuery } from "@tanstack/react-query";
import type { SourceTemplate } from "@trust/extension-sdk";
import { Braces } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { useRuntime } from "../../lib/runtime-context.js";
import { Badge } from "../../ui/badge.js";
import { FilterBox } from "../../ui/filter-box.js";
import { CardGrid, NameList, ResourceCard } from "../shared/resource-card.js";
import { ResourceHome } from "../shared/resource-home.js";
import { ResourceTable, TitleCell } from "../shared/resource-table.js";
import { useUrlFilters } from "../shared/use-url-filters.js";
import { templateError } from "./template-renderer.js";

interface Filters {
  q: string;
  origin: string;
  view: "cards" | "list";
  group: "none" | "origin";
  sort: "name" | "parameters";
}
const read = (params: URLSearchParams): Filters => ({
  q: params.get("q") ?? "",
  origin: params.get("origin") ?? "",
  view: params.get("view") === "list" ? "list" : "cards",
  group: params.get("group") === "origin" ? "origin" : "none",
  sort: params.get("sort") === "parameters" ? "parameters" : "name",
});
const write = (filters: Filters, base: URLSearchParams) => {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(filters)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
};

export function TemplatesHome() {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const location = useLocation();
  const catalog = useQuery({ queryKey: ["templates"], queryFn: runtime.templates });
  const [filters, update] = useUrlFilters(read, write, "templates");
  const rows = catalog.data ?? [];
  const origin = (row: SourceTemplate) => (row.builtIn ? "built-in" : "custom");
  const originLabel = (row: SourceTemplate) => t(row.builtIn ? "templates.builtinLabel" : "templates.customLabel");
  const visible = rows
    .filter(
      (row) =>
        (!filters.origin || origin(row) === filters.origin) &&
        `${row.title} ${row.id} ${row.description}`.toLowerCase().includes(filters.q.toLowerCase()),
    )
    .sort((a, b) =>
      filters.sort === "parameters"
        ? b.parameters.length - a.parameters.length || a.title.localeCompare(b.title)
        : a.title.localeCompare(b.title),
    );
  const groups =
    filters.group === "origin"
      ? ["built-in", "custom"]
          .map((key) => ({
            key,
            label: t(key === "built-in" ? "templates.builtinLabel" : "templates.customLabel"),
            rows: visible.filter((row) => origin(row) === key),
          }))
          .filter((group) => group.rows.length)
      : [{ key: "all", label: "", rows: visible }];
  const to = (row: SourceTemplate) => `/templates/${encodeURIComponent(row.id)}${location.search}`;
  return (
    <ResourceHome
      crumbs={[{ label: "TRUST", to: "/overview" }, { label: t("templates.title") }]}
      title={t("templates.title")}
      total={rows.length}
      visible={visible.length}
      createTo={`/templates/new${location.search}`}
      createLabel={t("templates.new")}
      filterBox={
        <FilterBox
          query={filters.q}
          onQuery={(q) => update({ q })}
          placeholder={t("templates.search")}
          groups={[
            {
              id: "origin",
              label: t("templates.origin"),
              exclusive: true,
              selected: filters.origin ? [filters.origin] : [],
              options: [
                {
                  value: "built-in",
                  label: t("templates.builtinLabel"),
                  count: rows.filter((row) => row.builtIn).length,
                },
                {
                  value: "custom",
                  label: t("templates.customLabel"),
                  count: rows.filter((row) => !row.builtIn).length,
                },
              ],
              onToggle: (value) => update({ origin: filters.origin === value ? "" : value }),
            },
          ]}
          onClearAll={() => update({ q: "", origin: "" })}
        />
      }
      display={{
        view: filters.view,
        onView: (view) => update({ view }),
        group: filters.group,
        onGroup: (group) => update({ group }),
        groupOptions: [
          { value: "none", label: t("templates.ungrouped") },
          { value: "origin", label: t("templates.origin") },
        ],
        sort: filters.sort,
        onSort: (sort) => update({ sort }),
        sortOptions: [
          { value: "name", label: t("templates.name") },
          { value: "parameters", label: t("templates.parameters") },
        ],
      }}
      loading={catalog.isLoading}
      error={catalog.error ? templateError(catalog.error) : undefined}
      emptyTitle={t(rows.length === 0 ? "templates.emptyCatalog" : "templates.empty")}
      emptyBody={rows.length === 0 ? t("templates.emptyCatalogHint") : undefined}
      onClearFilters={() => update({ q: "", origin: "" })}
      groups={groups}
      overlayOpen={location.pathname !== "/templates" && location.pathname !== "/templates/"}
      renderCards={(list) => (
        <CardGrid>
          {list.map((row) => (
            <ResourceCard
              key={row.id}
              to={to(row)}
              title={row.title}
              id={row.id}
              description={row.description}
              marks={<Badge tone={row.builtIn ? "neutral" : "info"}>{originLabel(row)}</Badge>}
              facts={[
                {
                  label: t("templates.parameters"),
                  value: <NameList names={row.parameters.map((parameter) => parameter.name)} />,
                },
              ]}
              footerLeft={
                <span className="inline-flex items-center gap-1">
                  <Braces size={12} />
                  {row.parameters.length}
                </span>
              }
              footerRight={t("templates.revision", { revision: String(row.revision) })}
            />
          ))}
        </CardGrid>
      )}
      renderList={(list) => (
        <ResourceTable
          columns={[
            { key: "template", label: t("templates.select"), width: "40%" },
            { key: "parameters", label: t("templates.parameters") },
            { key: "origin", label: t("templates.origin") },
            { key: "revision", label: t("templates.revisionLabel") },
          ]}
          rows={list}
          rowKey={(row) => row.id}
          renderCells={(row) => [
            <TitleCell key="title" to={to(row)} title={row.title} id={row.id} description={row.description} />,
            <NameList key="params" names={row.parameters.map((parameter) => parameter.name)} />,
            <Badge key="origin" tone={row.builtIn ? "neutral" : "info"}>
              {originLabel(row)}
            </Badge>,
            <span key="revision" className="mono text-muted">
              {row.revision}
            </span>,
          ]}
        />
      )}
    />
  );
}
