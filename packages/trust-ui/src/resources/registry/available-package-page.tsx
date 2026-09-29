import {
  EXTENSION_CAPABILITIES,
  type ExtensionCapability,
  type ExtensionSettingsValues,
  type RegistryAvailablePackage,
  type RegistryPackageInstallRequest,
} from "@trust/extension-sdk";
import { Download } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { useEnvironments } from "../../lib/runtime-context.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { Field } from "../../ui/controls.js";
import { Expert } from "../../ui/expert.js";
import { Select } from "../../ui/select.js";
import { EmptyState, LoadingState } from "../../ui/states.js";
import { registryFailure, useInstallPackage, useRegistryIndex } from "./registry-data.js";
import {
  CategoryBadges,
  DataTable,
  Facts,
  Fold,
  Panel,
  packagePath,
  RegistryFailureBox,
  RegistryPage,
  StepsStrip,
  settingsPath,
  sourcePath,
  WIDE_CELL,
} from "./registry-parts.js";

/* One package version offered by a source: every located content with its identity and digest, then its individual
   installation. Only the declared categories are processed; a build runs only when the package declares code. */

export function AvailablePackagePage() {
  const { t } = useTranslation();
  const { source = "", package: name = "", version = "" } = useParams();
  const index = useRegistryIndex(source);
  const offered = index.data?.packages.find((value) => value.name === name && value.version === version);
  const crumbs = [
    { label: source, to: sourcePath(source), mono: true },
    { label: `${name} ${version}`, mono: true },
  ];
  if (index.isLoading) return <LoadingState />;
  if (!offered)
    return (
      <RegistryPage crumbs={crumbs} title={`${name} ${version}`}>
        {index.isError ? <RegistryFailureBox error={index.error} /> : null}
        <EmptyState title={t("registry.packages.unknown")} body={t("registry.packages.unknownBody")} />
      </RegistryPage>
    );
  return (
    <RegistryPage
      crumbs={crumbs}
      title={`${offered.name} ${offered.version}`}
      subtitle={offered.description ?? offered.title ?? t("registry.packages.fromSource", { source })}
    >
      <Panel title={t("registry.packages.summary")}>
        <Facts
          rows={[
            [
              t("registry.packages.columns.package"),
              <span key="n" className="mono">
                {offered.name}
              </span>,
            ],
            [
              t("registry.packages.columns.version"),
              <span key="v" className="mono">
                {offered.version}
              </span>,
            ],
            [
              t("registry.packages.source"),
              <Link key="s" to={sourcePath(source)} className="mono text-accent hover:underline">
                {source}
              </Link>,
            ],
            [t("registry.packages.columns.contents"), <CategoryBadges key="c" categories={offered.categories} />],
            [
              t("registry.packages.buildLabel"),
              offered.buildRequired ? t("registry.packages.buildRequired") : t("registry.packages.noBuild"),
            ],
            [
              t("registry.packages.columns.installed"),
              offered.installedVersion ? (
                <Link key="i" to={packagePath(offered.name)} className="text-accent hover:underline">
                  {t("registry.packages.installedVersion", { version: offered.installedVersion })}
                </Link>
              ) : (
                t("registry.packages.notInstalled")
              ),
            ],
          ]}
        />
      </Panel>
      <ContentsPanel offered={offered} base={index.data?.base ?? ""} revision={index.data?.revision ?? ""} />
      <InstallPanel source={source} offered={offered} />
    </RegistryPage>
  );
}

function ContentsPanel({
  offered,
  base,
  revision,
}: {
  offered: RegistryAvailablePackage;
  base: string;
  revision: string;
}) {
  const { t } = useTranslation();
  return (
    <Panel title={t("registry.contents.title", { count: offered.contents.length })}>
      <p className="mb-2 text-body text-muted">
        {t("registry.contents.base")} <span className="mono text-text">{base}</span>
        {" · "}
        {t("registry.contents.revision")} <span className="mono text-text">{revision.slice(0, 12)}</span>
      </p>
      <DataTable
        label={t("registry.contents.tableLabel")}
        dense
        columns={[
          { key: "category", label: t("registry.contents.columns.category") },
          { key: "path", label: t("registry.contents.columns.path") },
          { key: "identity", label: t("registry.contents.columns.identity"), wide: true },
          { key: "sha", label: t("registry.contents.columns.sha"), wide: true },
        ]}
      >
        {offered.contents.map((content) => (
          <tr key={content.path}>
            <td>{t(`registry.contents.kind.${content.kind}`)}</td>
            <td className="mono break-all">{content.path}</td>
            <td className={`mono ${WIDE_CELL}`}>{content.name ? `${content.name}@${content.version}` : "—"}</td>
            <td className={`mono ${WIDE_CELL}`} title={content.sha256}>
              <Expert fallback={`${content.sha256.slice(0, 8)}…`}>{content.sha256}</Expert>
            </td>
          </tr>
        ))}
      </DataTable>
    </Panel>
  );
}

function InstallPanel({ source, offered }: { source: string; offered: RegistryAvailablePackage }) {
  const { t } = useTranslation();
  const install = useInstallPackage();
  const environments = useEnvironments();
  const hasCode = offered.categories.includes("extension");
  const [chosen, setEnvironment] = useState("");
  const onlyEnvironment = environments.data?.length === 1 ? environments.data[0]?.name : undefined;
  const environment = chosen || onlyEnvironment || "";
  const [grants, setGrants] = useState<ExtensionCapability[]>([]);
  const [settingsText, setSettingsText] = useState("");
  const settings = parseSettings(settingsText);
  const result = install.data;
  const failure = registryFailure(install.error);
  if (offered.installedVersion && !result)
    return (
      <Panel title={t("registry.install.title")}>
        <p className="text-body-lg">
          {offered.installedVersion === offered.version
            ? t("registry.install.alreadyThis")
            : t("registry.install.alreadyOther", { version: offered.installedVersion })}{" "}
          {offered.installedVersion !== offered.version ? (
            <Link
              to={`${packagePath(offered.name)}/update?version=${encodeURIComponent(offered.version)}`}
              className="text-accent hover:underline"
            >
              {t("registry.install.updateInstead", { version: offered.version })}
            </Link>
          ) : null}
        </p>
      </Panel>
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (settings === "invalid") return;
    const request: RegistryPackageInstallRequest = {
      source,
      package: offered.name,
      version: offered.version,
      ...(hasCode
        ? {
            extension: {
              environment,
              grants,
              ...(settings ? { settings } : {}),
            },
          }
        : {}),
    };
    install.mutate(request);
  };
  return (
    <Panel title={t("registry.install.title")}>
      {result ? (
        <div role="status" className="flex flex-col gap-3">
          <p className="text-body-lg font-medium">
            {t("registry.install.done", { name: result.package.name, version: result.package.version })}
          </p>
          <StepsStrip steps={result.steps} />
          {result.catalog.length ? (
            <Fold title={t("registry.install.catalog")} meta={<Badge>{result.catalog.length}</Badge>} open>
              <ul className="flex flex-col gap-1 text-body">
                {result.catalog.map((entry) => (
                  <li key={`${entry.kind}:${entry.name}@${entry.version}`}>
                    {t(`registry.contents.kind.${entry.kind}`)}{" "}
                    <span className="mono">
                      {entry.name}@{entry.version}
                    </span>{" "}
                    <Badge tone={entry.status === "imported" ? "success" : "neutral"}>
                      {t(`registry.install.import.${entry.status}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Fold>
          ) : null}
          {result.extension ? (
            <p className="text-body-lg">
              {t("registry.install.stopped", { extension: result.extension.id })}{" "}
              <Link to={settingsPath(result.extension.id)} className="text-accent hover:underline">
                {t("registry.installed.configure")}
              </Link>
            </p>
          ) : null}
          <Link to={packagePath(result.package.name)} className="text-accent hover:underline">
            {t("registry.install.openInstalled")}
          </Link>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit} aria-label={t("registry.install.title")}>
          <p className="text-body text-muted">
            {offered.buildRequired ? t("registry.install.withBuild") : t("registry.install.withoutBuild")}
          </p>
          {hasCode ? (
            <>
              <Field label={t("registry.install.environment")} hint={t("registry.install.environmentHint")}>
                <Select
                  ariaLabel={t("registry.install.environment")}
                  value={environment}
                  onChange={setEnvironment}
                  placeholder={t("registry.install.chooseEnvironment")}
                  options={(environments.data ?? []).map((entry) => ({ value: entry.name, label: entry.name }))}
                  className="max-w-sm"
                />
              </Field>
              <fieldset className="flex flex-col gap-1">
                <legend className="text-body-lg font-medium">{t("registry.install.grants")}</legend>
                <p className="text-caption text-faint">{t("registry.install.grantsHint")}</p>
                {EXTENSION_CAPABILITIES.map((capability) => (
                  <div key={capability} className="flex items-start gap-2 text-body-lg">
                    <input
                      id={`grant-${capability}`}
                      className="mt-1"
                      type="checkbox"
                      aria-describedby={`grant-${capability}-description`}
                      checked={grants.includes(capability)}
                      onChange={(event) =>
                        setGrants((current) =>
                          event.target.checked
                            ? [...current, capability]
                            : current.filter((value) => value !== capability),
                        )
                      }
                    />
                    <span className="flex min-w-0 flex-col">
                      <label htmlFor={`grant-${capability}`}>
                        {t(`registry.install.capability.${capability}.label`)}
                      </label>
                      <span id={`grant-${capability}-description`} className="text-caption text-muted">
                        {t(`registry.install.capability.${capability}.description`)}
                        <Expert>
                          {" · "}
                          <span className="mono">{capability}</span>
                        </Expert>
                      </span>
                    </span>
                  </div>
                ))}
              </fieldset>
              <Fold title={t("registry.install.initialSettings")}>
                <p className="mb-1 text-caption text-faint">{t("registry.install.initialSettingsHint")}</p>
                <textarea
                  aria-label={t("registry.install.initialSettings")}
                  value={settingsText}
                  onChange={(event) => setSettingsText(event.target.value)}
                  rows={4}
                  spellCheck={false}
                  className="mono w-full rounded-(--radius-2) border border-border bg-surface px-2.5 py-1.5 text-body"
                />
                {settings === "invalid" ? (
                  <p role="alert" className="text-caption text-danger">
                    {t("registry.install.settingsInvalid")}
                  </p>
                ) : null}
              </Fold>
            </>
          ) : (
            <p className="text-body text-muted">{t("registry.install.catalogOnly")}</p>
          )}
          {install.isError ? (
            <div className="flex flex-col gap-2">
              <RegistryFailureBox error={install.error} title={t("registry.install.failed")} />
              {failure?.step ? <StepsStrip failedAt={failure.step} /> : null}
              <p className="text-body text-muted">{t("registry.install.nothingInstalled")}</p>
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              icon={<Download size={14} aria-hidden="true" />}
              disabled={install.isPending || (hasCode && !environment) || settings === "invalid"}
            >
              {install.isPending
                ? t("registry.install.running")
                : t("registry.install.action", { name: offered.name, version: offered.version })}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

function parseSettings(text: string): ExtensionSettingsValues | undefined | "invalid" {
  if (!text.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
    if (Object.values(value).some((item) => !["string", "number", "boolean"].includes(typeof item))) return "invalid";
    return value as ExtensionSettingsValues;
  } catch {
    return "invalid";
  }
}
