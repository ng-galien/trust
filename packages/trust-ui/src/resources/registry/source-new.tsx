import { REGISTRY_INDEX_FILE, type RegistrySourceInput, type RegistrySourceKind } from "@trust/extension-sdk";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Button, ButtonLink } from "../../ui/button.js";
import { Field, SegmentedControl, TextInput } from "../../ui/controls.js";
import { useRegistrySources, useSaveSource } from "./registry-data.js";
import { Panel, RegistryFailureBox, RegistryPage, sourcePath, useRegistryContext } from "./registry-parts.js";

/* Add a registry source: a Git repository (fixed index at its root), an HTTP index URL or a local index file.
   Saving records the configuration only; reading the index is the separate, explicit refresh. */

export function SourceNewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { homeTab } = useRegistryContext();
  const save = useSaveSource();
  const sources = useRegistrySources();
  const [kind, setKind] = useState<RegistrySourceKind>("git");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [reference, setReference] = useState("");
  // Saving an existing name would silently re-point that source; adding refuses it.
  const taken = Boolean(sources.data?.some((source) => source.name === name.trim()));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (taken) return;
    const inputs: Record<RegistrySourceKind, () => RegistrySourceInput> = {
      git: () => ({
        name: name.trim(),
        kind: "git",
        url: url.trim(),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      }),
      http: () => ({ name: name.trim(), kind: "http", url: url.trim() }),
      file: () => ({ name: name.trim(), kind: "file", url: url.trim() }),
    };
    save.mutate(inputs[kind](), { onSuccess: (source) => void navigate(sourcePath(source.name)) });
  };
  return (
    <RegistryPage
      crumbs={[{ label: t("registry.sources.add") }]}
      title={t("registry.sources.add")}
      subtitle={t("registry.sources.addSubtitle")}
    >
      <Panel title={t("registry.sources.newSource")} className="max-w-3xl">
        <form className="flex flex-col gap-4" onSubmit={submit} aria-label={t("registry.sources.add")}>
          <Field label={t("registry.sources.name")} hint={t("registry.sources.nameHint")}>
            <TextInput
              aria-label={t("registry.sources.name")}
              aria-invalid={taken || undefined}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mono"
              required
              spellCheck={false}
            />
          </Field>
          {taken ? (
            <p role="alert" className="-mt-2 text-body text-danger">
              {t("registry.sources.nameTaken", { name: name.trim() })}
            </p>
          ) : null}
          <Field label={t("registry.sources.type")}>
            <SegmentedControl<RegistrySourceKind>
              ariaLabel={t("registry.sources.type")}
              value={kind}
              onChange={setKind}
              options={(["git", "http", "file"] as const).map((value) => ({
                value,
                label: t(`registry.sources.kind.${value}`),
              }))}
            />
          </Field>
          <Field label={t(`registry.sources.url.${kind}`)} hint={t(`registry.sources.urlHint.${kind}`)}>
            <TextInput
              aria-label={t(`registry.sources.url.${kind}`)}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="mono"
              required
              spellCheck={false}
            />
          </Field>
          {kind === "git" ? (
            <>
              <Field label={t("registry.sources.reference")} hint={t("registry.sources.referenceHint")}>
                <TextInput
                  aria-label={t("registry.sources.reference")}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  className="mono"
                  spellCheck={false}
                />
              </Field>
              <p className="text-body text-muted">
                {t("registry.sources.gitIndex")} <span className="mono text-text">{REGISTRY_INDEX_FILE}</span>
              </p>
            </>
          ) : null}
          <p className="text-body text-muted">{t("registry.sources.saveOnly")}</p>
          {save.isError ? <RegistryFailureBox error={save.error} title={t("registry.sources.saveFailed")} /> : null}
          <div className="flex justify-end gap-2">
            <ButtonLink to={homeTab("sources")}>{t("common.actions.cancel")}</ButtonLink>
            <Button type="submit" variant="primary" disabled={save.isPending || taken || !name.trim() || !url.trim()}>
              {save.isPending ? t("common.actions.saving") : t("registry.sources.save")}
            </Button>
          </div>
        </form>
      </Panel>
    </RegistryPage>
  );
}
