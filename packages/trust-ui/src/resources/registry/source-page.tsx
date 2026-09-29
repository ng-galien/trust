import { matchRegistrySource } from "@trust/extension-sdk/match";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { formatTime, relativeTime } from "../../lib/format.js";
import { useExpert } from "../../lib/preferences.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { ConfirmDialog } from "../../ui/confirm.js";
import { Expert } from "../../ui/expert.js";
import { EmptyState, LoadingState } from "../../ui/states.js";
import { useRefreshIndex, useRegistryIndex, useRegistrySources, useRemoveSource } from "./registry-data.js";
import {
  availablePath,
  CategoryBadges,
  DataTable,
  Facts,
  Panel,
  packagePath,
  RefreshOutcome,
  RegistryFailureBox,
  RegistryPage,
  SourceKindBadge,
  useRegistryContext,
  WIDE_CELL,
} from "./registry-parts.js";

/* One registry source: its configuration, its last refreshed index and every package it offers. Refreshing the
   index and removing the source are two distinct actions; neither installs, updates nor uninstalls a package. */

export function SourcePage() {
  const { t } = useTranslation();
  const { source: name = "" } = useParams();
  const { homeTab } = useRegistryContext();
  const sources = useRegistrySources();
  const removal = useRemoveSource();
  const removed = removal.data?.removed ? removal.data : undefined;
  const source = sources.data?.find((value) => value.name === name);
  const index = useRegistryIndex(name, Boolean(source) && !removed);
  const refresh = useRefreshIndex();
  const [confirming, setConfirming] = useState(false);
  const expert = useExpert();
  const crumbs = [{ label: name, mono: true }];

  if (removed)
    return (
      <RegistryPage crumbs={crumbs} title={name}>
        <Panel title={t("registry.remove.done", { source: removed.name })}>
          <div role="status" className="flex flex-col gap-2 text-body-lg">
            <p>{t("registry.remove.noUninstall")}</p>
            {removed.keptPackages.length ? (
              <div>
                <p className="text-muted">{t("registry.remove.kept")}</p>
                <ul aria-label={t("registry.remove.kept")} className="mt-1 flex flex-wrap gap-2">
                  {removed.keptPackages.map((value) => (
                    <li key={value}>
                      <Link to={packagePath(value)} className="mono text-accent hover:underline">
                        {value}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-muted">{t("registry.remove.noneInstalled")}</p>
            )}
            <Link to={homeTab("installed")} className="text-accent hover:underline">
              {t("registry.remove.backInstalled")}
            </Link>
          </div>
        </Panel>
      </RegistryPage>
    );
  if (sources.isLoading) return <LoadingState />;
  if (!source)
    return (
      <RegistryPage crumbs={crumbs} title={name}>
        <EmptyState title={t("registry.sources.unknown")} body={t("registry.sources.unknownBody")} />
      </RegistryPage>
    );
  const view = index.data;
  return (
    <RegistryPage
      crumbs={crumbs}
      title={source.name}
      subtitle={t("registry.sources.pageSubtitle")}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            icon={
              refresh.isPending ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw size={14} aria-hidden="true" />
              )
            }
            disabled={refresh.isPending}
            onClick={() => refresh.mutate(source.name)}
          >
            {refresh.isPending ? t("registry.refresh.running") : t("registry.refresh.action")}
          </Button>
          <Button variant="danger" icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => setConfirming(true)}>
            {t("registry.remove.action")}
          </Button>
        </div>
      }
    >
      <Panel title={t("registry.sources.configuration")}>
        <Facts
          rows={[
            [t("registry.sources.type"), <SourceKindBadge key="kind" kind={source.kind} />],
            [
              t(`registry.sources.url.${source.kind}`),
              <span key="url" className="mono break-all">
                {source.url}
              </span>,
            ],
            matchRegistrySource<[string, ReactNode] | false>(source, {
              git: (git) => [
                t("registry.sources.reference"),
                <span key="ref" className="mono">
                  {git.reference ?? t("registry.sources.defaultBranch")}
                </span>,
              ],
              http: () => false,
              file: () => false,
            }),
            view && [
              t("registry.sources.index"),
              <span key="index">
                {t("registry.sources.readAgo", { time: relativeTime(view.refreshedAt) })}{" "}
                <span className="text-caption text-muted">({formatTime(view.refreshedAt)})</span>
              </span>,
            ],
            expert &&
              view && [
                t("registry.sources.indexRevision"),
                <span key="rev" className="mono break-all">
                  {view.revision}
                </span>,
              ],
            expert &&
              view && [
                t("registry.sources.base"),
                <span key="base" className="mono break-all">
                  {view.base}
                </span>,
              ],
          ]}
        />
        <p className="mt-3 text-body text-muted">{t("registry.sources.refreshPolicy")}</p>
      </Panel>
      <RefreshOutcome refresh={refresh} />
      {removal.isError ? <RegistryFailureBox error={removal.error} /> : null}
      {index.isLoading ? (
        <LoadingState />
      ) : index.isError ? (
        <RegistryFailureBox error={index.error} />
      ) : !view ? (
        <EmptyState
          title={t("registry.sources.notRefreshed")}
          body={t("registry.sources.notRefreshedBody")}
          action={
            <Button variant="primary" disabled={refresh.isPending} onClick={() => refresh.mutate(source.name)}>
              {t("registry.refresh.action")}
            </Button>
          }
        />
      ) : (
        <Panel title={t("registry.packages.title", { count: view.packages.length })}>
          {view.packages.length === 0 ? (
            <p className="text-body text-muted">{t("registry.packages.empty")}</p>
          ) : (
            <DataTable
              label={t("registry.packages.tableLabel")}
              columns={[
                { key: "package", label: t("registry.packages.columns.package") },
                { key: "version", label: t("registry.packages.columns.version") },
                { key: "contents", label: t("registry.packages.columns.contents"), wide: true },
                { key: "installed", label: t("registry.packages.columns.installed") },
              ]}
            >
              {view.packages.map((value) => (
                <tr key={`${value.name}@${value.version}`} aria-label={`${value.name} ${value.version}`}>
                  <td>
                    <Link
                      to={availablePath(source.name, value.name, value.version)}
                      className="block leading-tight hover:underline"
                    >
                      <span className="mono block font-semibold">{value.name}</span>
                      {value.title ? <span className="block text-caption text-muted">{value.title}</span> : null}
                    </Link>
                  </td>
                  <td className="mono">{value.version}</td>
                  <td className={WIDE_CELL}>
                    <span className="flex flex-wrap items-center gap-1">
                      <CategoryBadges categories={value.categories} />
                      {value.buildRequired ? <Badge tone="neutral">{t("registry.packages.build")}</Badge> : null}
                    </span>
                  </td>
                  <td>
                    {value.installedVersion ? (
                      <Link to={packagePath(value.name)}>
                        <Badge tone={value.installedVersion === value.version ? "success" : "neutral"}>
                          {t("registry.packages.installedVersion", { version: value.installedVersion })}
                        </Badge>
                      </Link>
                    ) : (
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span className="text-muted">{t("registry.packages.notInstalled")}</span>
                        <Link
                          to={availablePath(source.name, value.name, value.version)}
                          className="text-ui font-medium text-accent hover:underline"
                        >
                          {t("registry.packages.install")}
                        </Link>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
          <Expert>
            <p className="mt-2 text-caption text-muted">{t("registry.packages.contract")}</p>
          </Expert>
        </Panel>
      )}
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={t("registry.remove.confirmTitle", { source: source.name })}
        body={t("registry.remove.confirmBody")}
        confirmLabel={t("registry.remove.action")}
        busy={removal.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => removal.mutate(source.name, { onSettled: () => setConfirming(false) })}
      />
    </RegistryPage>
  );
}
