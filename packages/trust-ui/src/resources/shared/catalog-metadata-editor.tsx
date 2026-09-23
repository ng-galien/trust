import type { CatalogMetadata } from "@trust/extension-sdk";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { mutationError, useSaveCatalogMetadata } from "../../lib/mutations.js";
import { Button } from "../../ui/button.js";

/** Catalog wording and classification are independent of a published executable version. */
export function CatalogMetadataEditor({ metadata }: { metadata: CatalogMetadata }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(metadata.title);
  const [description, setDescription] = useState(metadata.description ?? "");
  const [tags, setTags] = useState(metadata.tags.join("\n"));
  const save = useSaveCatalogMetadata();

  const open = () => {
    setTitle(metadata.title);
    setDescription(metadata.description ?? "");
    setTags(metadata.tags.join("\n"));
    setEditing(true);
  };

  return (
    <section className="rounded-(--radius-3) border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-ui font-semibold">{t("shared.catalogMetadata.heading")}</h2>
        {!editing ? (
          <Button size="sm" onClick={open}>
            {t("shared.catalogMetadata.edit")}
          </Button>
        ) : null}
      </div>
      {!editing ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {metadata.tags.length ? (
            metadata.tags.map((tag) => (
              <span key={tag} className="rounded-(--radius-1) bg-surface-3 px-2 py-0.5 text-caption">
                {tag}
              </span>
            ))
          ) : (
            <span className="text-caption text-muted">{t("shared.catalogMetadata.noTags")}</span>
          )}
        </div>
      ) : (
        <form
          className="mt-3 grid max-w-3xl gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              {
                kind: metadata.kind,
                name: metadata.name,
                expectedRevision: metadata.revision,
                title: title.trim(),
                description,
                tags: tags
                  .split(/\r?\n/)
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              },
              { onSuccess: () => setEditing(false) },
            );
          }}
        >
          <label className="grid gap-1 text-caption font-medium">
            {t("shared.catalogMetadata.title")}
            <input
              className="rounded-(--radius-2) border border-border bg-bg px-2 py-1.5 text-ui"
              value={title}
              maxLength={180}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-caption font-medium">
            {t("shared.catalogMetadata.description")}
            <textarea
              className="min-h-28 rounded-(--radius-2) border border-border bg-bg px-2 py-1.5 text-ui"
              value={description}
              maxLength={8000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-caption font-medium">
            {t("shared.catalogMetadata.tags")}
            <textarea
              className="rounded-(--radius-2) border border-border bg-bg px-2 py-1.5 text-ui"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder={t("shared.catalogMetadata.tagsHint")}
            />
          </label>
          {save.error ? (
            <p role="alert" className="text-caption text-danger">
              {mutationError(save.error)}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={save.isPending}>
              {t("shared.catalogMetadata.save")}
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              {t("shared.catalogMetadata.cancel")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
