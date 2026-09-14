import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRuntime } from "../../lib/runtime-context.js";
import { Button } from "../../ui/button.js";
import { Select } from "../../ui/select.js";
import { ErrorBox, LoadingState } from "../../ui/states.js";
import { TemplateRenderer, templateError } from "./template-renderer.js";

export function ProcedureTemplatePicker({ onApply }: { onApply: (source: string) => void }) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const catalog = useQuery({ queryKey: ["templates"], queryFn: runtime.templates, enabled: open });
  const selected = catalog.data?.find((template) => template.id === id);
  return (
    <div className="shrink-0 border-b border-border p-3">
      <Button size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        {t(open ? "templates.closePicker" : "templates.openPicker")}
      </Button>
      {open && (
        <div className="mt-3 flex min-h-0 flex-col gap-3">
          {catalog.isLoading && <LoadingState />}
          {catalog.error && <ErrorBox message={templateError(catalog.error)} />}
          <Select
            ariaLabel={t("templates.select")}
            value={id}
            onChange={setId}
            placeholder={t("templates.choose")}
            options={(catalog.data ?? []).map((template) => ({ value: template.id, label: template.title }))}
          />
          {selected && (
            <div className="h-[40vh] min-h-72 overflow-hidden rounded-(--radius-2) border border-border">
              <TemplateRenderer
                key={`${selected.id}@${selected.revision}`}
                template={selected}
                onApply={(source) => {
                  onApply(source);
                  setOpen(false);
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
