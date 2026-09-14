import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SourceTemplate, TemplateSaveRequest } from "@trust/extension-sdk";
import { Copy, FileText, Pencil, Play, Plus, Save, Trash2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useRuntime } from "../../lib/runtime-context.js";
import { Badge } from "../../ui/badge.js";
import { Button, IconButton } from "../../ui/button.js";
import { ConfirmDialog } from "../../ui/confirm.js";
import { Field, TextInput } from "../../ui/controls.js";
import { EmptyState, ErrorBox, LoadingState } from "../../ui/states.js";
import { InspectorSection } from "../shared/inspector.js";
import { useOverlayViewState } from "../shared/overlay-state.js";
import { ResourceOverlay } from "../shared/resource-overlay.js";
import { TemplateRenderer, templateError } from "./template-renderer.js";
import { TemplateSourceEditor } from "./template-source-editor.js";

export function TemplateOverlay({ mode = "item" }: { mode?: "item" | "new" }) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const { template: id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const catalog = useQuery({ queryKey: ["templates"], queryFn: runtime.templates });
  const current = catalog.data?.find((item) => item.id === (mode === "new" ? search.get("from") : id));
  if (catalog.isLoading)
    return (
      <div className="absolute inset-0 z-30 bg-surface">
        <LoadingState />
      </div>
    );
  if (catalog.error || (mode === "item" && !current))
    return (
      <div className="absolute inset-0 z-30 bg-surface p-6">
        <ErrorBox message={catalog.error ? templateError(catalog.error) : t("templates.notFound")} />
        <Button onClick={() => navigate("/templates")}>{t("templates.back")}</Button>
      </div>
    );
  return <TemplateDetail key={`${mode}:${current?.id ?? "new"}`} current={current} isNew={mode === "new"} />;
}

function TemplateDetail({ current, isNew }: { current: SourceTemplate | undefined; isNew: boolean }) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { tab, setTab } = useOverlayViewState(["use", "source"] as const, isNew ? "source" : "use");
  const initial = (copy = false): TemplateSaveRequest => ({
    id: current ? (copy ? `${current.id}-copy` : current.id) : "",
    title: current?.title ?? "",
    description: current?.description ?? "",
    body: current?.body ?? "",
    parameters: current?.parameters ?? [],
    expectedRevision: copy ? 0 : (current?.revision ?? 0),
  });
  const [draft, setDraft] = useState<TemplateSaveRequest | null>(() => (isNew ? initial(true) : null));
  const [parameterKeys, setParameterKeys] = useState(() => (current?.parameters ?? []).map(() => crypto.randomUUID()));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"delete" | "discard" | null>(null);
  const closeState = useRef({ pending, draft });
  closeState.current = { pending, draft };
  const close = useCallback(() => {
    if (closeState.current.pending) return;
    if (closeState.current.draft) setConfirm("discard");
    else navigate("/templates");
  }, [navigate]);
  const save = async () => {
    if (!draft) return;
    setPending(true);
    setError("");
    try {
      const result = await runtime.saveTemplate(draft);
      await client.invalidateQueries({ queryKey: ["templates"] });
      setDraft(null);
      navigate(`/templates/${encodeURIComponent(result.id)}`);
    } catch (error) {
      setError(templateError(error));
    } finally {
      setPending(false);
    }
  };
  const remove = async () => {
    if (!current) return;
    setPending(true);
    setError("");
    try {
      await runtime.removeTemplate(current.id, current.revision);
      await client.invalidateQueries({ queryKey: ["templates"] });
      navigate("/templates");
    } catch (error) {
      setError(templateError(error));
      setConfirm(null);
    } finally {
      setPending(false);
    }
  };
  const value = draft ?? current;
  const editParameter = (index: number, patch: Partial<TemplateSaveRequest["parameters"][number]>) => {
    if (draft)
      setDraft({
        ...draft,
        parameters: draft.parameters.map((item, i) => (i === index ? { ...item, ...patch } : item)),
      });
  };
  const editable = Boolean(draft);
  return (
    <ResourceOverlay
      onClose={close}
      crumbs={[
        { label: t("templates.title"), to: "/templates" },
        { label: isNew ? t("templates.new") : (current?.title ?? "") },
      ]}
      labelledBy="template-title"
      kicker={t("templates.select")}
      badges={
        <Badge tone={editable ? "warning" : current?.builtIn ? "neutral" : "info"}>
          {editable ? t("templates.draft") : t(current?.builtIn ? "templates.builtinLabel" : "templates.customLabel")}
        </Badge>
      }
      id={value?.id ?? ""}
      title={value?.title || t("templates.new")}
      actions={
        draft ? (
          <>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                if (isNew) setConfirm("discard");
                else {
                  setDraft(null);
                  setError("");
                  setTab("use");
                }
              }}
            >
              {t("templates.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Save size={13} />}
              disabled={pending}
              onClick={() => void save()}
            >
              {t("templates.save")}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              icon={<Copy size={13} />}
              onClick={() => navigate(`/templates/new?from=${encodeURIComponent(current?.id ?? "")}`)}
            >
              {t("templates.clone")}
            </Button>
            {!current?.builtIn && (
              <>
                <Button
                  size="sm"
                  icon={<Pencil size={13} />}
                  onClick={() => {
                    setParameterKeys((current?.parameters ?? []).map(() => crypto.randomUUID()));
                    setDraft(initial());
                    setTab("source");
                  }}
                >
                  {t("templates.edit")}
                </Button>
                <IconButton size="sm" label={t("templates.delete")} onClick={() => setConfirm("delete")}>
                  <Trash2 size={14} />
                </IconButton>
              </>
            )}
          </>
        )
      }
      tabs={[
        {
          value: "use",
          label: (
            <>
              <Play size={13} />
              {t("templates.useTab")}
            </>
          ),
        },
        {
          value: "source",
          label: (
            <>
              <FileText size={13} />
              {t("templates.sourceTab")}
            </>
          ),
        },
      ]}
      tab={tab}
      onTab={setTab}
      tabMeta={draft ? t("templates.unsaved") : t("templates.revision", { revision: String(current?.revision ?? 0) })}
      inspector={
        <>
          <InspectorSection title={t("templates.details")}>
            <div className="flex flex-col gap-3">
              {editable && draft ? (
                <>
                  <Field label={t("templates.id")}>
                    <TextInput
                      aria-label={t("templates.id")}
                      disabled={pending || !isNew}
                      value={draft.id}
                      onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    />
                  </Field>
                  <Field label={t("templates.name")}>
                    <TextInput
                      aria-label={t("templates.name")}
                      disabled={pending}
                      value={draft.title}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    />
                  </Field>
                  <Field label={t("templates.summary")}>
                    <TextInput
                      aria-label={t("templates.summary")}
                      disabled={pending}
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <p className="text-body-lg leading-relaxed text-muted">{current?.description}</p>
                  <span className="text-caption text-faint">
                    {t(current?.builtIn ? "templates.builtIn" : "templates.customLabel")}
                  </span>
                </>
              )}
            </div>
          </InspectorSection>
          <InspectorSection title={t("templates.parameters")} count={value?.parameters.length ?? 0}>
            <div className="flex flex-col gap-4">
              {value?.parameters.map((parameter, index) => (
                <div key={draft ? parameterKeys[index] : parameter.name} className="flex flex-col gap-2">
                  {draft ? (
                    <>
                      <div className="flex items-end gap-2">
                        <Field label={t("templates.parameterName")} className="min-w-0 flex-1">
                          <TextInput
                            aria-label={`${t("templates.parameterName")} ${index + 1}`}
                            disabled={pending}
                            value={parameter.name}
                            onChange={(e) => editParameter(index, { name: e.target.value })}
                          />
                        </Field>
                        <IconButton
                          size="sm"
                          label={`${t("templates.removeParameter")} ${index + 1}`}
                          disabled={pending}
                          onClick={() => {
                            setParameterKeys(parameterKeys.filter((_, i) => i !== index));
                            setDraft({ ...draft, parameters: draft.parameters.filter((_, i) => i !== index) });
                          }}
                        >
                          <X size={13} />
                        </IconButton>
                      </div>
                      <TextInput
                        aria-label={`${t("templates.summary")} ${index + 1}`}
                        placeholder={t("templates.summary")}
                        disabled={pending}
                        value={parameter.description}
                        onChange={(e) => editParameter(index, { description: e.target.value })}
                      />
                      <Button
                        size="sm"
                        disabled={pending}
                        aria-label={`${t("templates.useDefault")} ${index + 1}`}
                        aria-pressed={parameter.defaultValue !== undefined}
                        onClick={() => {
                          const next = {
                            name: parameter.name,
                            description: parameter.description,
                            ...(parameter.defaultValue === undefined ? { defaultValue: "" } : {}),
                          };
                          setDraft({
                            ...draft,
                            parameters: draft.parameters.map((item, i) => (i === index ? next : item)),
                          });
                        }}
                      >
                        {parameter.defaultValue === undefined ? t("templates.noDefault") : t("templates.useDefault")}
                      </Button>
                      <TextInput
                        aria-label={`${t("templates.defaultValue")} ${index + 1}`}
                        placeholder={t("templates.defaultValue")}
                        disabled={pending}
                        value={parameter.defaultValue ?? ""}
                        onChange={(e) => editParameter(index, { defaultValue: e.target.value })}
                      />
                    </>
                  ) : (
                    <>
                      <span className="mono text-body font-medium">{parameter.name}</span>
                      <p className="text-caption text-muted">{parameter.description}</p>
                      {parameter.defaultValue !== undefined && (
                        <p className="mono text-caption text-faint">{parameter.defaultValue}</p>
                      )}
                    </>
                  )}
                </div>
              ))}
              {draft && (
                <Button
                  size="sm"
                  icon={<Plus size={13} />}
                  disabled={pending}
                  onClick={() => {
                    setParameterKeys([...parameterKeys, crypto.randomUUID()]);
                    setDraft({ ...draft, parameters: [...draft.parameters, { name: "", description: "" }] });
                  }}
                >
                  {t("templates.addParameter")}
                </Button>
              )}
              {!draft && !value?.parameters.length && (
                <span className="text-caption text-muted">{t("templates.noParameters")}</span>
              )}
            </div>
          </InspectorSection>
        </>
      }
    >
      <div className="relative flex h-full min-h-0 flex-col">
        {error && (
          <div className="border-b border-border p-3">
            <ErrorBox message={error} />
          </div>
        )}
        {tab === "source" ? (
          <>
            <div className="border-b border-border bg-surface-2 px-4 py-2 text-caption text-muted">
              {t("templates.bodyHint")}
            </div>
            <div className="min-h-0 flex-1">
              <TemplateSourceEditor
                label={t("templates.sourceTab")}
                parameters={value?.parameters}
                value={value?.body ?? ""}
                readOnly={!draft || pending}
                onChange={(body) => {
                  if (draft) setDraft({ ...draft, body });
                }}
              />
            </div>
          </>
        ) : draft ? (
          <div className="p-6">
            <EmptyState
              title={t("templates.saveBeforePreview")}
              action={
                <Button variant="primary" disabled={pending} onClick={() => void save()}>
                  {t("templates.save")}
                </Button>
              }
            />
          </div>
        ) : current ? (
          <TemplateRenderer key={`${current.id}@${current.revision}`} template={current} />
        ) : null}
        <ConfirmDialog
          open={confirm !== null}
          title={t(confirm === "delete" ? "templates.delete" : "templates.discardTitle")}
          body={t(confirm === "delete" ? "templates.deleteHint" : "templates.discardBody")}
          tone={confirm === "delete" ? "danger" : "primary"}
          confirmLabel={t(confirm === "delete" ? "templates.confirmDelete" : "templates.discard")}
          busy={pending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm === "delete") void remove();
            else navigate("/templates");
          }}
        />
      </div>
    </ResourceOverlay>
  );
}
