import type { SourceTemplate } from "@trust/extension-sdk";
import { Check, Copy, Play } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRuntime } from "../../lib/runtime-context.js";
import { RuntimeError } from "../../runtime.js";
import { Button } from "../../ui/button.js";
import { Field, TextInput } from "../../ui/controls.js";
import { EmptyState, ErrorBox } from "../../ui/states.js";
import { TemplateSourceEditor } from "./template-source-editor.js";

export const templateError = (error: unknown) =>
  error instanceof RuntimeError ? error.detail : error instanceof Error ? error.message : String(error);
export function TemplateRenderer({
  template,
  onApply,
}: {
  template: SourceTemplate;
  onApply?: (source: string) => void;
}) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.parameters.map((parameter) => [parameter.name, parameter.defaultValue ?? ""])),
  );
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const render = async () => {
    setPending(true);
    setError("");
    setSource(null);
    setCopied(false);
    try {
      setSource(
        (await runtime.renderTemplate({ id: template.id, expectedRevision: template.revision, values })).source,
      );
    } catch (error) {
      setError(templateError(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="flex h-full min-h-0 flex-col md:flex-row" aria-label={t("templates.use")}>
      <div className="flex w-full shrink-0 flex-col border-b border-border bg-surface md:w-48 xl:w-64 md:border-b-0 md:border-r">
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <h2 className="kicker mb-4">{t("templates.parameters")}</h2>
          <div className="flex flex-col gap-4">
            {template.parameters.map((parameter) => (
              <Field key={parameter.name} label={parameter.name}>
                <TextInput
                  aria-label={parameter.name}
                  title={parameter.description}
                  disabled={pending}
                  value={values[parameter.name] ?? ""}
                  onChange={(e) => {
                    setValues({ ...values, [parameter.name]: e.target.value });
                    setSource(null);
                    setCopied(false);
                  }}
                />
                {parameter.description && (
                  <p className="text-caption leading-relaxed text-muted">{parameter.description}</p>
                )}
              </Field>
            ))}
            {!template.parameters.length && <p className="text-body text-muted">{t("templates.noParameters")}</p>}
          </div>
        </div>
        <div className="shrink-0 border-t border-border px-4 py-3">
          <Button
            variant="primary"
            size="sm"
            icon={<Play size={13} />}
            disabled={pending}
            onClick={() => void render()}
          >
            {t("templates.preview")}
          </Button>
        </div>
      </div>
      <div className="flex min-h-64 min-w-0 flex-1 flex-col">
        <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2 px-4 py-1.5">
          <span className="text-label text-muted">{t("templates.result")}</span>
          {source !== null && (
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                size="sm"
                icon={copied ? <Check size={13} /> : <Copy size={13} />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(source);
                    setCopied(true);
                  } catch (error) {
                    setError(templateError(error));
                  }
                }}
              >
                {t(copied ? "templates.copied" : "templates.copy")}
              </Button>
              {onApply && (
                <Button
                  size="sm"
                  variant="primary"
                  className="h-auto min-h-7 whitespace-normal text-left"
                  onClick={() => onApply(source)}
                >
                  {t("templates.replace")}
                </Button>
              )}
            </div>
          )}
        </div>
        {error && (
          <div className="p-3">
            <ErrorBox message={error} />
          </div>
        )}
        <div className="min-h-0 flex-1">
          {source === null ? (
            <div className="p-6">
              <EmptyState title={t("templates.previewEmpty")} body={t("templates.previewHint")} />
            </div>
          ) : (
            <TemplateSourceEditor value={source} label={t("templates.result")} readOnly materialized />
          )}
        </div>
        {onApply && (
          <p className="shrink-0 border-t border-border px-4 py-2 text-caption text-muted">
            {t("templates.replaceHint")}
          </p>
        )}
      </div>
    </section>
  );
}
