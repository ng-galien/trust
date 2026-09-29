import { ArrowUpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router";

import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { Field } from "../../ui/controls.js";
import { Select } from "../../ui/select.js";
import { LoadingState } from "../../ui/states.js";
import { useInstalledPackage } from "./installed-package-page.js";
import { PrepareAndStart, StateBadge } from "./lifecycle.js";
import { registryFailure, useUpdatePackage } from "./registry-data.js";
import {
  DataTable,
  Fold,
  ItemList,
  PackageMissing,
  Panel,
  packagePath,
  RegistryFailureBox,
  RegistryPage,
  StepsStrip,
} from "./registry-parts.js";

/* Explicit update of one installed package to an identified version of its source. The installed and target
   versions and the effects are shown before it runs; a failure is reported while the previous version stays. */

export function PackageUpdatePage() {
  const { t } = useTranslation();
  const { package: name = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { installed, extension, loading } = useInstalledPackage(name);
  const update = useUpdatePackage();
  const crumbs = [{ label: name, mono: true, to: packagePath(name) }, { label: t("registry.update.crumb") }];
  if (loading) return <LoadingState />;
  const result = update.data;
  if (!installed && !result) return <PackageMissing name={name} />;
  const targets = (installed?.availableVersions ?? []).filter((version) => version !== installed?.version);
  const requested = params.get("version") ?? "";
  const target = targets.includes(requested) ? requested : "";
  const failure = registryFailure(update.error);
  const running = installed?.version ?? result?.package.version ?? "";
  return (
    <RegistryPage crumbs={crumbs} title={t("registry.update.title", { name })} subtitle={t("registry.update.subtitle")}>
      {result ? (
        <Panel title={t("registry.update.done", { name, from: result.previousVersion, to: result.package.version })}>
          <div role="status" className="flex flex-col gap-3">
            <StepsStrip steps={result.steps} />
            {result.extension ? (
              <p className="flex items-center gap-2 text-body-lg">
                {t("registry.update.extensionNow", { version: result.extension.version })}
                <StateBadge state={result.extension.state} />
              </p>
            ) : null}
            {result.preparationRequired && result.extension ? (
              <PrepareAndStart
                extension={{ id: result.extension.id, title: extension?.title ?? name }}
                message={t("registry.update.preparationRequired")}
              />
            ) : null}
            <Fold title={t("registry.update.removed")} meta={<Badge>{result.removed.length}</Badge>}>
              <ItemList items={result.removed} label={t("registry.update.removed")} />
            </Fold>
            <Link to={packagePath(name)} className="text-accent hover:underline">
              {t("registry.update.backToPackage")}
            </Link>
          </div>
        </Panel>
      ) : installed ? (
        <Panel title={t("registry.update.plan")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("registry.update.installed")}>
              <output aria-label={t("registry.update.installed")} className="mono text-body-lg">
                {installed.version}
              </output>
            </Field>
            <Field label={t("registry.update.target")}>
              {targets.length ? (
                <Select
                  ariaLabel={t("registry.update.target")}
                  value={target}
                  placeholder={t("registry.update.chooseTarget")}
                  onChange={(version) => {
                    update.reset();
                    const next = new URLSearchParams(params);
                    next.set("version", version);
                    setParams(next, { replace: true });
                  }}
                  options={targets.map((version) => ({ value: version, label: version }))}
                  className="max-w-xs"
                />
              ) : (
                <span className="text-body text-muted">{t("registry.update.noTarget")}</span>
              )}
            </Field>
          </div>
          {target ? (
            <p className="mt-3 text-body-lg">{t("registry.update.fromTo", { from: installed.version, to: target })}</p>
          ) : null}
          <div className="mt-3">
            <DataTable
              label={t("registry.update.effectsLabel")}
              dense
              columns={[
                { key: "element", label: t("registry.update.element") },
                { key: "effect", label: t("registry.update.effect") },
              ]}
            >
              {installed.extension ? (
                <tr>
                  <td>{t("registry.update.effects.codeLabel")}</td>
                  <td>{t("registry.update.effects.code", { version: target || "…" })}</td>
                </tr>
              ) : null}
              <tr>
                <td>{t("registry.update.effects.catalogLabel")}</td>
                <td>{t("registry.update.effects.catalog", { version: installed.version })}</td>
              </tr>
              <tr>
                <td>{t("registry.update.effects.plansLabel")}</td>
                <td>{t("registry.update.effects.plans")}</td>
              </tr>
              {installed.extension ? (
                <tr>
                  <td>{t("registry.update.effects.storageLabel")}</td>
                  <td>{t("registry.update.effects.storage")}</td>
                </tr>
              ) : null}
            </DataTable>
          </div>
          <p className="mt-3 text-body text-muted">{t("registry.update.onFailure", { version: installed.version })}</p>
          {update.isError ? (
            <div className="mt-3 flex flex-col gap-2">
              <RegistryFailureBox error={update.error} title={t("registry.update.failed")} />
              {failure?.step ? <StepsStrip failedAt={failure.step} /> : null}
              <p role="status" className="flex flex-wrap items-center gap-2 text-body-lg font-medium">
                {t("registry.update.stillActive", { version: running })}
                {extension ? <StateBadge state={extension.state} /> : null}
              </p>
            </div>
          ) : null}
          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              icon={<ArrowUpCircle size={14} aria-hidden="true" />}
              disabled={!target || update.isPending}
              onClick={() => update.mutate({ package: installed.name, version: target })}
            >
              {update.isPending
                ? t("registry.update.running")
                : target
                  ? t("registry.update.action", { version: target })
                  : t("registry.installed.update")}
            </Button>
          </div>
        </Panel>
      ) : null}
    </RegistryPage>
  );
}
