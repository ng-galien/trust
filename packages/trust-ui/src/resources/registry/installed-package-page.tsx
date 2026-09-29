import type { ExtensionDescriptor, RegistryInstalledPackage } from "@trust/extension-sdk";
import { ArrowUpCircle, Settings2, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { useExtensions } from "../../lib/extensions.js";
import { formatTime } from "../../lib/format.js";
import { Badge } from "../../ui/badge.js";
import { ButtonLink } from "../../ui/button.js";
import { Expert } from "../../ui/expert.js";
import { LoadingState } from "../../ui/states.js";
import { canUpdate, newerVersion } from "./extension-management.js";
import { LifecyclePanel, StateBadge } from "./lifecycle.js";
import { useInstalledPackages, useRegistrySources } from "./registry-data.js";
import {
  CategoryBadges,
  Facts,
  Fold,
  PackageMissing,
  Panel,
  packagePath,
  RegistryPage,
  settingsPath,
  sourcePath,
} from "./registry-parts.js";

/* One installed package: version, source, contents and the explicit actions on it (configure, update, uninstall),
   each on its own page. */

/** The installed package, its running extension and whether its source is still configured. */
export function useInstalledPackage(name: string) {
  const packages = useInstalledPackages();
  const catalog = useExtensions();
  const sources = useRegistrySources();
  const installed = packages.data?.find((value) => value.name === name);
  const extension = installed?.extension
    ? catalog.data?.extensions.find((value) => value.id === installed.extension?.id)
    : undefined;
  const sourceKnown = Boolean(installed && sources.data?.some((value) => value.name === installed.source));
  return { packages, installed, extension, sourceKnown, loading: packages.isLoading };
}

export function InstalledPackagePage() {
  const { t } = useTranslation();
  const { package: name = "" } = useParams();
  const { installed, extension, sourceKnown, loading } = useInstalledPackage(name);
  if (loading) return <LoadingState />;
  if (!installed) return <PackageMissing name={name} />;
  const newer = newerVersion(installed);
  return (
    <RegistryPage
      crumbs={[{ label: installed.name, mono: true }]}
      title={extension?.title ?? installed.name}
      subtitle={t("registry.package.subtitle", { name: installed.name, version: installed.version })}
      actions={
        <div className="flex flex-wrap gap-2">
          {installed.extension ? (
            <ButtonLink to={settingsPath(installed.extension.id)} icon={<Settings2 size={14} aria-hidden="true" />}>
              {t("registry.installed.configure")}
            </ButtonLink>
          ) : null}
          {canUpdate(installed) ? (
            <ButtonLink
              to={`${packagePath(installed.name)}/update${newer ? `?version=${encodeURIComponent(newer)}` : ""}`}
              variant={newer ? "primary" : "secondary"}
              icon={<ArrowUpCircle size={14} aria-hidden="true" />}
            >
              {newer ? t("registry.installed.updateTo", { version: newer }) : t("registry.installed.update")}
            </ButtonLink>
          ) : null}
          <ButtonLink
            to={`${packagePath(installed.name)}/uninstall`}
            variant="danger"
            icon={<Trash2 size={14} aria-hidden="true" />}
          >
            {t("registry.installed.uninstall")}
          </ButtonLink>
        </div>
      }
    >
      <PackageSummary installed={installed} extension={extension} sourceKnown={sourceKnown} />
      {extension ? (
        <Panel title={t("registry.lifecycle.title")}>
          <LifecyclePanel extension={extension} />
        </Panel>
      ) : null}
      <Fold
        title={t("registry.package.availableVersions")}
        meta={<Badge>{installed.availableVersions.length}</Badge>}
        open={Boolean(newer)}
      >
        {installed.availableVersions.length === 0 ? (
          <p className="text-body text-muted">
            {sourceKnown ? t("registry.package.noVersions") : t("registry.package.sourceGone")}
          </p>
        ) : (
          <ul aria-label={t("registry.package.availableVersions")} className="flex flex-col gap-1 text-body-lg">
            {installed.availableVersions.map((version) => (
              <li key={version} className="flex items-center gap-2">
                <span className="mono">{version}</span>
                {version === installed.version ? (
                  <Badge tone="success">{t("registry.package.current")}</Badge>
                ) : (
                  <Link
                    to={`${packagePath(installed.name)}/update?version=${encodeURIComponent(version)}`}
                    className="text-accent hover:underline"
                  >
                    {installed.availableVersions.indexOf(version) >
                    installed.availableVersions.indexOf(installed.version)
                      ? t("registry.installed.updateTo", { version })
                      : t("registry.package.changeTo", { version })}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-caption text-muted">{t("registry.package.explicitUpdate")}</p>
      </Fold>
      <Fold title={t("registry.package.contents")} meta={<CategoryBadges categories={installed.categories} />}>
        <PackageContents installed={installed} />
      </Fold>
    </RegistryPage>
  );
}

export function PackageSummary({
  installed,
  extension,
  sourceKnown,
}: {
  installed: RegistryInstalledPackage;
  extension: ExtensionDescriptor | undefined;
  sourceKnown: boolean;
}) {
  const { t } = useTranslation();
  const rows: Array<[string, ReactNode] | false> = [
    [
      t("registry.package.installedVersion"),
      <span key="v" className="mono">
        {installed.version}
      </span>,
    ],
    [
      t("registry.packages.source"),
      sourceKnown ? (
        <Link key="s" to={sourcePath(installed.source)} className="mono text-accent hover:underline">
          {installed.source}
        </Link>
      ) : (
        <span key="s" className="mono">
          {installed.source} <Badge tone="warning">{t("registry.installed.sourceRemoved")}</Badge>
        </span>
      ),
    ],
    Boolean(installed.extension) && [
      t("registry.package.state"),
      extension ? <StateBadge key="st" state={extension.state} /> : "—",
    ],
    [t("registry.packages.columns.contents"), <CategoryBadges key="c" categories={installed.categories} />],
    [t("registry.package.updatedAt"), formatTime(installed.updatedAt)],
  ];
  return (
    <Panel title={t("registry.packages.summary")}>
      <Facts rows={rows} />
      <Expert>
        <div className="mt-2">
          <Facts
            rows={[
              [
                t("registry.sources.indexRevision"),
                <span key="r" className="mono break-all">
                  {installed.revision}
                </span>,
              ],
              [
                t("registry.package.directory"),
                <span key="d" className="mono break-all">
                  {installed.directory}
                </span>,
              ],
              [t("registry.package.installedAt"), formatTime(installed.installedAt)],
            ]}
          />
        </div>
      </Expert>
      {extension?.error ? (
        <p role="alert" className="mt-2 text-body text-danger">
          {extension.error.message}
        </p>
      ) : null}
    </Panel>
  );
}

function PackageContents({ installed }: { installed: RegistryInstalledPackage }) {
  const { t } = useTranslation();
  const entries = [
    ...(installed.extension
      ? [{ kind: "extension" as const, name: installed.extension.id, version: installed.extension.version }]
      : []),
    ...installed.operations.map((value) => ({ kind: "operation" as const, ...value })),
    ...installed.procedures.map((value) => ({ kind: "procedure" as const, ...value })),
  ];
  return (
    <ul className="flex flex-col gap-1 text-body-lg">
      {entries.map((entry) => (
        <li key={`${entry.kind}:${entry.name}`}>
          {t(`registry.contents.kind.${entry.kind}`)}{" "}
          <span className="mono">
            {entry.name}@{entry.version}
          </span>
        </li>
      ))}
    </ul>
  );
}
