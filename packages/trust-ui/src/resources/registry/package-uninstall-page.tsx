import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { Button, ButtonLink } from "../../ui/button.js";
import { ConfirmDialog } from "../../ui/confirm.js";
import { TextInput } from "../../ui/controls.js";
import { LoadingState } from "../../ui/states.js";
import { useInstalledPackage } from "./installed-package-page.js";
import { useUninstallPackage } from "./registry-data.js";
import {
  ItemList,
  PackageMissing,
  Panel,
  packagePath,
  RegistryFailureBox,
  RegistryPage,
  useRegistryContext,
} from "./registry-parts.js";

/* Uninstall one package: what is removed and what is kept is stated before, and reported after, the action.
   Deleting the extension's own data is a separate choice, off by default and confirmed by typing the package name. */

export function PackageUninstallPage() {
  const { t } = useTranslation();
  const { package: name = "" } = useParams();
  const { homeTab } = useRegistryContext();
  const { installed, extension, loading } = useInstalledPackage(name);
  const uninstall = useUninstallPackage();
  const [deleteData, setDeleteData] = useState(false);
  const [typed, setTyped] = useState("");
  const [confirming, setConfirming] = useState(false);
  const crumbs = [
    { label: name, mono: true, ...(installed ? { to: packagePath(name) } : {}) },
    { label: t("registry.uninstall.crumb") },
  ];
  const result = uninstall.data;
  if (result)
    return (
      <RegistryPage crumbs={crumbs} title={t("registry.uninstall.title", { name })}>
        <Panel title={t("registry.uninstall.done", { name: result.package.name, version: result.package.version })}>
          <div role="status" className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <h3 className="mb-1 text-ui font-semibold">{t("registry.uninstall.removed")}</h3>
              <ItemList items={result.removed} label={t("registry.uninstall.removed")} />
            </div>
            <div className="min-w-0">
              <h3 className="mb-1 text-ui font-semibold">{t("registry.uninstall.kept")}</h3>
              <ItemList items={result.kept} label={t("registry.uninstall.kept")} />
            </div>
          </div>
          <Link to={homeTab("installed")} className="mt-3 inline-block text-accent hover:underline">
            {t("extensions.back")}
          </Link>
        </Panel>
      </RegistryPage>
    );
  if (loading) return <LoadingState />;
  if (!installed) return <PackageMissing name={name} />;
  const hasCode = Boolean(installed.extension);
  const ready = !deleteData || typed.trim() === installed.name;
  return (
    <RegistryPage
      crumbs={crumbs}
      title={t("registry.uninstall.title", { name })}
      subtitle={t("registry.uninstall.subtitle")}
    >
      <Panel title={t("registry.uninstall.plan", { name: installed.name, version: installed.version })} tone="danger">
        {extension?.state === "RUNNING" ? (
          <p className="mb-3 text-body-lg">{t("registry.uninstall.preview.stop")}</p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-ui font-semibold">{t("registry.uninstall.willRemove")}</h3>
            <ul className="list-disc pl-5 text-body-lg">
              {hasCode ? <li>{t("registry.uninstall.preview.code", { version: installed.version })}</li> : null}
              {hasCode ? <li>{t("registry.uninstall.preview.settings")}</li> : null}
              <li>{t("registry.uninstall.preview.files")}</li>
              {deleteData ? <li>{t("registry.uninstall.preview.data")}</li> : null}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-ui font-semibold">{t("registry.uninstall.willKeep")}</h3>
            <ul className="list-disc pl-5 text-body-lg">
              {hasCode && !deleteData ? <li>{t("registry.uninstall.preview.data")}</li> : null}
              {installed.operations.length || installed.procedures.length ? (
                <li>{t("registry.uninstall.preview.catalog")}</li>
              ) : null}
              <li>{t("registry.uninstall.preview.plans")}</li>
              <li>{t("registry.uninstall.preview.source", { source: installed.source })}</li>
            </ul>
          </div>
        </div>
        {hasCode ? (
          <div className="mt-4 rounded-(--radius-2) border border-danger/30 bg-danger-soft/40 p-3">
            <label className="flex items-center gap-2 text-body-lg font-medium">
              <input
                type="checkbox"
                checked={deleteData}
                onChange={(event) => {
                  setDeleteData(event.target.checked);
                  setTyped("");
                }}
              />
              {t("registry.uninstall.deleteData")}
            </label>
            <p className="mt-1 text-caption text-muted">{t("registry.uninstall.deleteDataHint")}</p>
            {deleteData ? (
              <div className="mt-2 flex flex-col gap-1 text-body">
                <label htmlFor="uninstall-confirm-name">
                  {t("registry.uninstall.typeName", { name: installed.name })}
                </label>
                <TextInput
                  id="uninstall-confirm-name"
                  aria-label={t("registry.uninstall.typeNameLabel")}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  className="mono max-w-xs"
                  spellCheck={false}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {uninstall.isError ? (
          <div className="mt-3">
            <RegistryFailureBox error={uninstall.error} title={t("registry.uninstall.failed")} />
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <ButtonLink to={packagePath(installed.name)}>{t("common.actions.cancel")}</ButtonLink>
          <Button
            variant="danger"
            icon={<Trash2 size={14} aria-hidden="true" />}
            disabled={!ready || uninstall.isPending}
            onClick={() => setConfirming(true)}
          >
            {t("registry.uninstall.action")}
          </Button>
        </div>
      </Panel>
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={t("registry.uninstall.confirmTitle", { name: installed.name, version: installed.version })}
        body={deleteData ? t("registry.uninstall.confirmWithData") : t("registry.uninstall.confirmKeepData")}
        confirmLabel={t("registry.uninstall.action")}
        busy={uninstall.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          uninstall.mutate(
            { package: installed.name, ...(deleteData ? { deleteData: true } : {}) },
            { onSettled: () => setConfirming(false) },
          )
        }
      />
    </RegistryPage>
  );
}
