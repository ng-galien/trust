import {
  type ExtensionSettingsIssue,
  type ExtensionSettingsSchema,
  type ExtensionSettingsValues,
  type ExtensionSettingsView,
  type ExtensionSettingValue,
  type RuntimeJsonObject,
  validateExtensionSettings,
} from "@trust/extension-sdk";
import { matchExtensionSettingProperty } from "@trust/extension-sdk/match";
import { AlertCircle, Check, Save } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { useExtensions } from "../../lib/extensions.js";
import { Button } from "../../ui/button.js";
import { Expert } from "../../ui/expert.js";
import { type ObjectSchema, type PropertySpec, SchemaForm } from "../../ui/schema.js";
import { EmptyState, LoadingState } from "../../ui/states.js";
import { PrepareAndStart, StateBadge } from "./lifecycle.js";
import {
  ExtensionRequestError,
  useExtensionSettings,
  useInstalledPackages,
  useUpdateExtensionSettings,
} from "./registry-data.js";
import { Facts, Fold, Notice, Panel, packagePath, RegistryFailureBox, RegistryPage } from "./registry-parts.js";

/* Settings of one installation, generated from the JSON Schema its extension declares (SDK contract). Values
   belong to the installation and are stored by the runtime; a credential is named by its environment variable. */

/** Blank fields are absent settings, never empty values. */
function present(value: RuntimeJsonObject): ExtensionSettingsValues {
  const values: Record<string, ExtensionSettingValue> = {};
  for (const [name, item] of Object.entries(value))
    if ((typeof item === "string" && item !== "") || typeof item === "number" || typeof item === "boolean")
      values[name] = item;
  return values;
}

/** Form projection of the settings contract: contract formats (absolute path, any URI, credential reference) are
    checked by the SDK validator below, not by the form's HTTP-oriented format rules. */
function formSchema(schema: ExtensionSettingsSchema): ObjectSchema {
  return {
    additionalProperties: false,
    ...(schema.required ? { required: schema.required } : {}),
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        matchExtensionSettingProperty<PropertySpec>(property, {
          string: ({ format: _format, ...rest }) => rest,
          integer: (setting) => setting,
          number: (setting) => setting,
          boolean: (setting) => setting,
        }),
      ]),
    ),
  };
}

export function ExtensionSettingsPage() {
  const { t } = useTranslation();
  const { extension: id = "" } = useParams();
  const settings = useExtensionSettings(id);
  // Owned by the page: applying a revision reloads the form, and the outcome must stay visible across that reload.
  const save = useUpdateExtensionSettings(id);
  const catalog = useExtensions();
  const packages = useInstalledPackages();
  const extension = catalog.data?.extensions.find((value) => value.id === id);
  const owner = packages.data?.find((value) => value.extension?.id === id);
  const crumbs = [
    ...(owner ? [{ label: owner.name, mono: true, to: packagePath(owner.name) }] : [{ label: id, mono: true }]),
    { label: t("registry.settings.crumb") },
  ];
  const title = t("registry.settings.title", { name: extension?.title ?? id });
  if (settings.isLoading) return <LoadingState />;
  if (!settings.data)
    return (
      <RegistryPage crumbs={crumbs} title={title}>
        {settings.isError ? (
          <RegistryFailureBox error={settings.error} title={t("registry.settings.unavailable")} />
        ) : (
          <EmptyState title={t("registry.settings.unavailable")} />
        )}
      </RegistryPage>
    );
  return (
    <RegistryPage
      crumbs={crumbs}
      title={title}
      subtitle={t("registry.settings.subtitle")}
      actions={extension ? <StateBadge state={extension.state} /> : null}
    >
      <SettingsForm
        key={settings.data.revision}
        view={settings.data}
        extension={{ id, title: extension?.title ?? id }}
        save={save}
      />
    </RegistryPage>
  );
}

function SettingsForm({
  view,
  extension,
  save,
}: {
  view: ExtensionSettingsView;
  extension: { id: string; title: string };
  save: ReturnType<typeof useUpdateExtensionSettings>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<RuntimeJsonObject>(() => ({ ...view.settings }));
  const [fieldIssues, setFieldIssues] = useState<Set<string>>(() => new Set());
  const values = present(value);
  const validation = validateExtensionSettings(view.schema, values);
  const issues: readonly ExtensionSettingsIssue[] = validation.valid ? [] : validation.issues;
  const summary = issues.filter((issue) => issue.path === "" || !fieldIssues.has(issue.path.slice(1)));
  const serverIssues = save.error instanceof ExtensionRequestError ? save.error.issues : [];
  const properties = Object.keys(view.schema.properties);
  return (
    <>
      <Panel title={t("registry.settings.form")}>
        <p className="mb-3 text-body text-muted">{t("registry.settings.generated")}</p>
        {properties.length === 0 ? (
          <p className="text-body text-muted">{t("registry.settings.none")}</p>
        ) : (
          <form
            aria-label={t("registry.settings.form")}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!validation.valid) return;
              save.mutate({ expectedRevision: view.revision, settings: values });
            }}
          >
            <SchemaForm
              schema={formSchema(view.schema)}
              value={value}
              onChange={(next) => {
                save.reset();
                setValue(next);
              }}
              onValidity={(_valid, current) => setFieldIssues(new Set(current.map((issue) => issue.field)))}
              idPrefix={`settings-${extension.id}`}
              showSummary={false}
            />
            <Constraints schema={view.schema} />
            {summary.length ? (
              <IssueList title={t("registry.settings.invalid")} issues={summary} />
            ) : validation.valid ? (
              <p className="inline-flex items-center gap-1 text-label text-success">
                <Check size={12} aria-hidden="true" /> {t("registry.settings.valid")}
              </p>
            ) : null}
            {serverIssues.length ? (
              <IssueList title={t("registry.settings.rejected")} issues={serverIssues} />
            ) : save.isError ? (
              <p role="alert" className="text-body text-danger">
                {save.error instanceof Error ? save.error.message : t("registry.settings.saveFailed")}
              </p>
            ) : null}
            {save.isSuccess ? (
              <Notice tone="success">
                {t("registry.settings.saved", { revision: String(save.data.settings.revision) })}
              </Notice>
            ) : null}
            {save.isSuccess && save.data.preparationRequired ? (
              <PrepareAndStart extension={extension} message={t("registry.settings.preparationRequired")} />
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  save.reset();
                  setValue({ ...view.settings });
                }}
              >
                {t("registry.settings.reset")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                icon={<Save size={14} aria-hidden="true" />}
                disabled={!validation.valid || save.isPending}
              >
                {save.isPending ? t("common.actions.saving") : t("registry.settings.apply")}
              </Button>
            </div>
          </form>
        )}
      </Panel>
      <Expert>
        <Fold
          title={t("registry.settings.stored")}
          meta={
            <span className="mono">{t("registry.settings.revisionShort", { revision: String(view.revision) })}</span>
          }
        >
          <Facts
            rows={[
              [t("registry.settings.origin"), t(`registry.settings.originValue.${view.source}`)],
              [t("registry.settings.revision"), String(view.revision)],
              [
                t("registry.settings.effective"),
                <pre key="e" className="mono whitespace-pre-wrap break-all text-caption">
                  {JSON.stringify(view.effective, null, 2)}
                </pre>,
              ],
            ]}
          />
        </Fold>
      </Expert>
      <p className="text-body text-muted">
        {t("registry.settings.secrets")}{" "}
        <Link to="/environments" className="text-accent hover:underline">
          {t("registry.settings.environments")}
        </Link>
      </p>
    </>
  );
}

function Constraints({ schema }: { schema: ExtensionSettingsSchema }) {
  const { t } = useTranslation();
  const lines = [
    ...((schema.oneOf ?? []).length
      ? [
          t("registry.settings.oneOf", {
            branches: (schema.oneOf ?? []).map((b) => b.required.join(" + ")).join(" | "),
          }),
        ]
      : []),
    ...((schema.anyOf ?? []).length
      ? [
          t("registry.settings.anyOf", {
            branches: (schema.anyOf ?? []).map((b) => b.required.join(" + ")).join(" | "),
          }),
        ]
      : []),
    ...Object.entries(schema.dependentRequired ?? {}).map(([name, list]) =>
      t("registry.settings.dependentRequired", { name, required: list.join(", ") }),
    ),
  ];
  if (!lines.length) return null;
  return (
    <ul aria-label={t("registry.settings.constraints")} className="list-disc pl-5 text-body text-muted">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function IssueList({ title, issues }: { title: string; issues: readonly ExtensionSettingsIssue[] }) {
  return (
    <div role="alert" className="rounded-(--radius-2) border border-danger/30 bg-danger-soft px-3 py-2 text-danger">
      <p className="flex items-center gap-1 text-body-lg font-medium">
        <AlertCircle size={14} aria-hidden="true" /> {title}
      </p>
      <ul className="mt-1 list-disc pl-5 text-body">
        {issues.map((issue) => (
          <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );
}
