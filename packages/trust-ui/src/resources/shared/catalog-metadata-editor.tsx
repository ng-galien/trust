import type { CatalogMetadata } from "@trust/extension-sdk";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { mutationError, useUpdateCatalogMetadata } from "../../lib/mutations.js";
import { Button } from "../../ui/button.js";
import { TextInput } from "../../ui/controls.js";
import { ErrorBox } from "../../ui/states.js";
import { catalogTags } from "./catalog-tags.js";

function tagLines(classification: CatalogMetadata["classification"]): string {
  return catalogTags(classification).join("\n");
}

function parseTags(lines: string): Record<string, string[]> | undefined {
  const classification: Record<string, string[]> = {};
  for (const line of lines.split(/\r?\n/)) {
    const tag = line.trim();
    if (!tag) continue;
    const match = /^@x-([a-z][a-z0-9]*(?:-[a-z0-9]+)*):([^\s:]+)$/.exec(tag);
    const key = match?.[1];
    const value = match?.[2];
    if (!key || !value) return undefined;
    classification[key] = [...(classification[key] ?? []), value];
  }
  return classification;
}

/** Editorial data for one published version; the compiled source remains unchanged. */
export function CatalogMetadataEditor({ metadata }: { metadata: CatalogMetadata }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(metadata.title);
  const [description, setDescription] = useState(metadata.description ?? "");
  const [tags, setTags] = useState(tagLines(metadata.classification));
  const update = useUpdateCatalogMetadata();
  const parsedTags = parseTags(tags);
  const dirty =
    title !== metadata.title ||
    description !== (metadata.description ?? "") ||
    tags !== tagLines(metadata.classification);

  const reset = () => {
    setTitle(metadata.title);
    setDescription(metadata.description ?? "");
    setTags(tagLines(metadata.classification));
    update.reset();
  };

  return (
    <div className="h-full overflow-y-auto bg-bg p-4" data-doc="catalog.metadata">
      <form
        className="mx-auto flex max-w-3xl flex-col gap-4 rounded-(--radius-3) border border-border bg-surface p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!parsedTags || !title.trim() || !dirty) return;
          update.mutate({
            kind: metadata.kind,
            name: metadata.name,
            version: metadata.version,
            expectedRevision: metadata.revision,
            title: title.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            classification: parsedTags,
          });
        }}
      >
        <div>
          <h2 className="text-subhead font-semibold">{t("common.catalog.title")}</h2>
          <p className="mt-1 text-body text-muted">{t("common.catalog.hint")}</p>
        </div>
        <label htmlFor="catalog-display-title" className="flex flex-col gap-1 text-body-lg font-medium">
          {t("common.catalog.displayTitle")}
          <TextInput
            id="catalog-display-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-body-lg font-medium">
          {t("common.catalog.description")}
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={10_000}
            rows={6}
            className="min-h-28 resize-y rounded-(--radius-2) border border-border bg-surface px-2.5 py-2 text-ui font-normal text-text focus:border-border-focus"
          />
        </label>
        <label className="flex flex-col gap-1 text-body-lg font-medium">
          {t("common.catalog.tags")}
          <span className="text-caption font-normal text-muted">{t("common.catalog.tagsHint")}</span>
          <textarea
            value={tags}
            aria-label={t("common.catalog.tags")}
            onChange={(event) => setTags(event.target.value)}
            rows={4}
            spellCheck={false}
            placeholder="@x-team:platform"
            className="mono min-h-24 resize-y rounded-(--radius-2) border border-border bg-surface px-2.5 py-2 text-body font-normal text-text focus:border-border-focus"
          />
        </label>
        {parsedTags === undefined ? <ErrorBox message={t("common.catalog.invalidTags")} /> : null}
        {update.error ? <ErrorBox message={mutationError(update.error) ?? t("common.catalog.saveFailed")} /> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={!dirty || !title.trim() || !parsedTags || update.isPending}>
            {t(update.isPending ? "common.actions.saving" : "common.actions.save")}
          </Button>
          {dirty ? <Button onClick={reset}>{t("common.actions.cancel")}</Button> : null}
          <span className="ml-auto text-caption text-faint">
            {t("common.catalog.revision", { revision: String(metadata.revision) })}
          </span>
        </div>
      </form>
    </div>
  );
}
