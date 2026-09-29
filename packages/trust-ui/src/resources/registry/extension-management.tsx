import type {
  ExtensionDescriptor,
  RegistryContentCategory,
  RegistryInstalledPackage,
  RegistrySource,
} from "@trust/extension-sdk";
import { matchRegistrySource } from "@trust/extension-sdk/match";
import { Loader2, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";

import { useExtensions } from "../../lib/extensions.js";
import { cx, relativeTime } from "../../lib/format.js";
import { Badge } from "../../ui/badge.js";
import { Button, ButtonLink, IconButton } from "../../ui/button.js";
import { SearchInput } from "../../ui/controls.js";
import { Expert } from "../../ui/expert.js";
import { Menu, type MenuEntry, type MenuItem, menuSeparator } from "../../ui/menu.js";
import { EmptyState, LoadingState } from "../../ui/states.js";
import { LifecycleOutcome, lifecycleActions, lifecycleIcon, StateBadge, useLifecycle } from "./lifecycle.js";
import { useInstalledPackages, useRefreshIndex, useRegistryIndex, useRegistrySources } from "./registry-data.js";
import {
  CategoryBadges,
  DataTable,
  packagePath,
  RefreshOutcome,
  RegistryFailureBox,
  RegistryPage,
  SourceKindBadge,
  settingsPath,
  sourcePath,
  useRegistryContext,
  useRestoredSelection,
  WIDE_CELL,
} from "./registry-parts.js";

/* Extension management has two entry pages reached from the navigation: installed extensions (with their source and
   contents) and registry sources. The filter lives in the URL so that every detail returns to the same view. */

interface InstalledRow {
  readonly key: string;
  readonly title: string;
  readonly id: string;
  readonly version: string;
  readonly newer: string | null;
  readonly descriptor: ExtensionDescriptor | undefined;
  readonly installed: RegistryInstalledPackage | undefined;
  readonly categories: readonly RegistryContentCategory[];
}

/** Newest version of the source index above the installed one, if any. */
export function newerVersion(value: RegistryInstalledPackage): string | null {
  const latest = value.latestVersion;
  if (!latest || latest === value.version) return null;
  return value.availableVersions.indexOf(latest) > value.availableVersions.indexOf(value.version) ? latest : null;
}

const workspacePath = (extension: string) => `/extensions/${encodeURIComponent(extension)}`;

/** An update is offered only when the source index lists another version than the installed one. */
export function canUpdate(value: RegistryInstalledPackage): boolean {
  return value.availableVersions.some((version) => version !== value.version);
}

function useFilter() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const setQuery = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value);
    else next.delete("q");
    setParams(next, { replace: true });
  };
  return { query, needle: query.trim().toLowerCase(), setQuery };
}

function AddSourceLink() {
  const { t } = useTranslation();
  return (
    <ButtonLink to="/extensions/sources/new" variant="primary" icon={<Plus size={14} aria-hidden="true" />}>
      {t("registry.sources.add")}
    </ButtonLink>
  );
}

export function InstalledExtensionsPage() {
  const { t } = useTranslation();
  const { query, needle, setQuery } = useFilter();
  const catalog = useExtensions();
  const packages = useInstalledPackages();
  const sources = useRegistrySources();
  const lifecycle = useLifecycle();
  useRegistryContext();
  const rows = useMemo(
    () => installedRows(catalog.data?.extensions ?? [], packages.data ?? []),
    [catalog.data, packages.data],
  );
  const visible = rows.filter((row) =>
    [row.title, row.id, row.installed?.source ?? ""].some((value) => value.toLowerCase().includes(needle)),
  );
  const known = new Set((sources.data ?? []).map((source) => source.name));
  // Only an operator's reload shows as pending; the periodic background polls stay silent.
  const [reloading, setReloading] = useState(false);
  const reload = () => {
    setReloading(true);
    void Promise.all([catalog.refetch(), packages.refetch(), sources.refetch()]).finally(() => setReloading(false));
  };
  return (
    <RegistryPage
      crumbs={[]}
      title={t("registry.pages.installedTitle")}
      subtitle={t("registry.pages.installedSubtitle")}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            icon={
              reloading ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw size={14} aria-hidden="true" />
              )
            }
            disabled={reloading}
            onClick={reload}
          >
            {reloading ? t("registry.home.refreshing") : t("extensions.refresh")}
          </Button>
          <AddSourceLink />
        </div>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-muted">{t("registry.home.installed", { count: rows.length })}</p>
        <SearchInput
          className="w-full sm:w-72"
          value={query}
          onChange={setQuery}
          placeholder={t("registry.home.filter")}
        />
      </div>
      <LifecycleOutcome lifecycle={lifecycle} />
      {catalog.isError ? (
        <RegistryFailureBox error={catalog.error} title={t("extensions.failed")} />
      ) : catalog.isLoading || packages.isLoading ? (
        <LoadingState />
      ) : (
        <>
          {packages.isError ? (
            <RegistryFailureBox error={packages.error} title={t("registry.home.packagesUnavailable")} />
          ) : null}
          {rows.length === 0 ? (
            <EmptyState title={t("extensions.empty")} body={t("registry.home.emptyInstalled")} />
          ) : visible.length === 0 ? (
            <p className="text-body text-muted">{t("registry.home.noMatch")}</p>
          ) : (
            <DataTable
              label={t("registry.pages.installedTitle")}
              framed
              columns={[
                { key: "extension", label: t("registry.installed.columns.extension") },
                { key: "version", label: t("registry.installed.columns.version") },
                { key: "state", label: t("registry.installed.columns.state") },
                { key: "source", label: t("registry.installed.columns.source"), wide: true },
                { key: "contents", label: t("registry.installed.columns.contents"), wide: true },
                { key: "actions", label: t("registry.installed.columns.actions"), srOnly: true },
              ]}
            >
              {visible.map((row) => (
                <InstalledRowView
                  key={row.key}
                  row={row}
                  lifecycle={lifecycle}
                  sourceKnown={row.installed ? known.has(row.installed.source) : true}
                />
              ))}
            </DataTable>
          )}
        </>
      )}
    </RegistryPage>
  );
}

function installedRows(
  descriptors: readonly ExtensionDescriptor[],
  packages: readonly RegistryInstalledPackage[],
): InstalledRow[] {
  const fromPackages = packages.map((value): InstalledRow => {
    const descriptor = value.extension ? descriptors.find((item) => item.id === value.extension?.id) : undefined;
    return {
      key: `package:${value.name}`,
      title: descriptor?.title ?? value.name,
      id: value.name,
      version: value.version,
      newer: newerVersion(value),
      descriptor,
      installed: value,
      categories: value.categories,
    };
  });
  const linked = new Set(packages.flatMap((value) => (value.extension ? [value.extension.id] : [])));
  const local = descriptors
    .filter((descriptor) => !linked.has(descriptor.id))
    .map(
      (descriptor): InstalledRow => ({
        key: `extension:${descriptor.id}`,
        title: descriptor.title,
        id: descriptor.id,
        version: descriptor.version,
        newer: null,
        descriptor,
        installed: undefined,
        categories: ["extension"],
      }),
    );
  return [...fromPackages, ...local].sort((a, b) => a.title.localeCompare(b.title));
}

function InstalledRowView({
  row,
  lifecycle,
  sourceKnown,
}: {
  row: InstalledRow;
  lifecycle: ReturnType<typeof useLifecycle>;
  sourceKnown: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { selected, select } = useRegistryContext();
  const isSelected = selected === row.key;
  const link = useRestoredSelection<HTMLAnchorElement>(isSelected);
  const extension = row.descriptor;
  const detail = row.installed ? packagePath(row.id) : extension ? settingsPath(extension.id) : undefined;
  const pending = extension ? lifecycle.pendingFor(extension.id) : undefined;
  const open = (to: string) => {
    select(row.key);
    void navigate(to);
  };
  // Only the transitions that apply to the current state, each explained; then the pages of the row.
  const transitions: MenuItem[] = extension
    ? lifecycleActions(extension.state).map((action) => ({
        label: t(`registry.lifecycle.action.${action}`),
        description: t(`registry.lifecycle.explain.${action}`),
        icon: lifecycleIcon[action],
        disabled: lifecycle.transition.isPending,
        disabledReason: t("registry.lifecycle.busy"),
        danger: action === "stop",
        onSelect: () => lifecycle.run(extension, action),
      }))
    : [];
  // The workspace is also in the menu, where it stays reachable at phone width.
  const pages: MenuItem[] = [
    ...(extension?.ui && extension.state === "RUNNING"
      ? [{ label: t("registry.installed.openWorkspaceMenu"), onSelect: () => open(workspacePath(extension.id)) }]
      : []),
    ...(row.installed ? [{ label: t("registry.installed.details"), onSelect: () => open(packagePath(row.id)) }] : []),
    ...(extension
      ? [{ label: t("registry.installed.configure"), onSelect: () => open(settingsPath(extension.id)) }]
      : []),
    ...(row.installed && canUpdate(row.installed)
      ? [
          {
            label: row.newer
              ? t("registry.installed.updateTo", { version: row.newer })
              : t("registry.installed.update"),
            onSelect: () =>
              open(`${packagePath(row.id)}/update${row.newer ? `?version=${encodeURIComponent(row.newer)}` : ""}`),
          },
        ]
      : []),
    ...(row.installed
      ? [
          {
            label: t("registry.installed.uninstall"),
            danger: true,
            onSelect: () => open(`${packagePath(row.id)}/uninstall`),
          },
        ]
      : []),
  ];
  const menu: MenuEntry[] = [...transitions, ...(transitions.length && pages.length ? [menuSeparator] : []), ...pages];
  return (
    <tr aria-label={row.title} data-selected={isSelected || undefined} className={cx(isSelected && "bg-accent-soft")}>
      <td>
        {detail ? (
          <Link ref={link} to={detail} onClick={() => select(row.key)} className="block leading-tight hover:underline">
            <span className="block text-ui font-semibold">{row.title}</span>
            <span className="mono block text-caption text-muted">{row.id}</span>
          </Link>
        ) : (
          <span className="block leading-tight">
            <span className="block text-ui font-semibold">{row.title}</span>
            <span className="mono block text-caption text-muted">{row.id}</span>
          </span>
        )}
        {extension?.error ? (
          <p role="alert" className="mt-1 text-caption text-danger">
            {extension.error.message}
          </p>
        ) : null}
      </td>
      <td>
        {/* The badge goes under the version on small screens so the row keeps its actions in view. */}
        <span className="flex flex-col items-start gap-1 md:flex-row md:items-center md:gap-1.5">
          <span className="mono whitespace-nowrap">{row.version}</span>
          {row.newer ? <Badge tone="warning">{t("registry.installed.available", { version: row.newer })}</Badge> : null}
        </span>
      </td>
      <td>
        {pending ? (
          <span className="inline-flex items-center gap-1.5 text-body text-muted">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            {t(`registry.lifecycle.running.${pending}`)}
          </span>
        ) : extension ? (
          <StateBadge state={extension.state} />
        ) : (
          <span className="text-caption text-muted">{t("registry.installed.catalogOnly")}</span>
        )}
      </td>
      <td className={WIDE_CELL}>
        {row.installed ? (
          sourceKnown ? (
            <Link to={sourcePath(row.installed.source)} className="mono hover:underline">
              {row.installed.source}
            </Link>
          ) : (
            <span className="mono">
              {row.installed.source} <Badge tone="warning">{t("registry.installed.sourceRemoved")}</Badge>
            </span>
          )
        ) : (
          <span className="text-muted">{t("registry.installed.localManifest")}</span>
        )}
      </td>
      <td className={WIDE_CELL}>
        <CategoryBadges categories={row.categories} />
      </td>
      <td>
        <div className="flex items-center justify-end gap-3">
          {extension?.ui && extension.state === "RUNNING" ? (
            <Link
              to={workspacePath(extension.id)}
              aria-label={t("registry.installed.openWorkspaceOf", { name: row.title })}
              className="hidden text-ui font-medium text-accent hover:underline md:inline"
            >
              {t("registry.installed.openWorkspace")}
            </Link>
          ) : null}
          {menu.length ? (
            <Menu
              label={t("registry.installed.actions", { name: row.title })}
              items={menu}
              trigger={({ toggle, attributes }) => (
                <IconButton
                  label={t("registry.installed.actions", { name: row.title })}
                  {...attributes}
                  onClick={toggle}
                >
                  <MoreHorizontal size={16} />
                </IconButton>
              )}
            />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

export function RegistrySourcesPage() {
  const { t } = useTranslation();
  const { query, needle, setQuery } = useFilter();
  const sources = useRegistrySources();
  const refresh = useRefreshIndex();
  useRegistryContext();
  const all = sources.data ?? [];
  const visible = all.filter((source) =>
    [source.name, source.url].some((value) => value.toLowerCase().includes(needle)),
  );
  return (
    <RegistryPage
      crumbs={[]}
      title={t("registry.pages.sourcesTitle")}
      subtitle={t("registry.pages.sourcesSubtitle")}
      actions={<AddSourceLink />}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-muted">{t("registry.sources.refreshPolicy")}</p>
        <SearchInput
          className="w-full sm:w-72"
          value={query}
          onChange={setQuery}
          placeholder={t("registry.home.filter")}
        />
      </div>
      {sources.isError ? (
        <RegistryFailureBox error={sources.error} />
      ) : sources.isLoading ? (
        <LoadingState />
      ) : all.length === 0 ? (
        <EmptyState
          title={t("registry.sources.empty")}
          body={t("registry.sources.emptyBody")}
          action={
            <Link to="/extensions/sources/new" className="text-accent underline">
              {t("registry.sources.add")}
            </Link>
          }
        />
      ) : visible.length === 0 ? (
        <p className="text-body text-muted">{t("registry.home.noMatch")}</p>
      ) : (
        <DataTable
          label={t("registry.pages.sourcesTitle")}
          framed
          columns={[
            { key: "source", label: t("registry.sources.columns.source") },
            { key: "address", label: t("registry.sources.columns.address"), wide: true },
            { key: "index", label: t("registry.sources.columns.index") },
            { key: "actions", label: t("registry.installed.columns.actions"), srOnly: true },
          ]}
        >
          {visible.map((source) => (
            <SourceRow
              key={source.name}
              source={source}
              busy={refresh.isPending && refresh.variables === source.name}
              disabled={refresh.isPending}
              onRefresh={() => refresh.mutate(source.name)}
            />
          ))}
        </DataTable>
      )}
      <RefreshOutcome refresh={refresh} />
    </RegistryPage>
  );
}

function SourceRow({
  source,
  busy,
  disabled,
  onRefresh,
}: {
  source: RegistrySource;
  busy: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const index = useRegistryIndex(source.name);
  const { selected, select } = useRegistryContext();
  const isSelected = selected === source.name;
  const link = useRestoredSelection<HTMLAnchorElement>(isSelected);
  const reference = matchRegistrySource(source, {
    git: (git) => git.reference,
    http: () => undefined,
    file: () => undefined,
  });
  return (
    <tr aria-label={source.name} data-selected={isSelected || undefined} className={cx(isSelected && "bg-accent-soft")}>
      <td>
        <Link
          ref={link}
          to={sourcePath(source.name)}
          onClick={() => select(source.name)}
          className="mono font-semibold hover:underline"
        >
          {source.name}
        </Link>
        <div className="mt-1">
          <SourceKindBadge kind={source.kind} />
        </div>
      </td>
      <td className={WIDE_CELL}>
        <span className="mono break-all text-body">{source.url}</span>
        {reference ? <span className="mono block text-caption text-muted">{reference}</span> : null}
      </td>
      <td>
        {index.data === null ? (
          <span className="text-muted">{t("registry.sources.notRefreshed")}</span>
        ) : index.data ? (
          <span>
            {t("registry.sources.packageCount", { count: index.data.packages.length })}
            <span className="block text-caption text-muted">
              {t("registry.sources.readAgo", { time: relativeTime(index.data.refreshedAt) })}
              <Expert>
                {" · "}
                <span className="mono">{index.data.revision.slice(0, 12)}</span>
              </Expert>
            </span>
          </span>
        ) : null}
      </td>
      <td className="text-right">
        <Button
          size="sm"
          aria-label={
            busy
              ? t("registry.refresh.runningFor", { source: source.name })
              : t("registry.refresh.actionFor", { source: source.name })
          }
          title={t("registry.refresh.explain")}
          icon={
            busy ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={13} aria-hidden="true" />
            )
          }
          disabled={disabled}
          onClick={onRefresh}
        >
          <span className="hidden sm:inline">
            {busy ? t("registry.refresh.running") : t("registry.refresh.action")}
          </span>
        </Button>
      </td>
    </tr>
  );
}
