import { AlertTriangle } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../lib/format.js";
import { Button } from "./button.js";

/* In-app confirmation dialog (never the browser's): themed, keyboard-dismissable, focus on the safe action.
   Escape is caught in the capture phase so an enclosing item overlay does not close underneath it. */

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = "primary",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay-backdrop)] p-4" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="overlay-enter w-full max-w-md rounded-(--radius-3) border border-border bg-surface p-4 shadow-(--shadow-3)">
        <div className="flex items-start gap-3">
          <span className={cx("mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full", tone === "danger" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent")}><AlertTriangle size={16} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="text-subhead font-semibold leading-snug">{title}</h2>
            {body ? <div className="mt-1 text-body-lg leading-relaxed text-muted">{body}</div> : null}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancel} onClick={onCancel} disabled={busy}>{cancelLabel ?? t("common.actions.cancel")}</Button>
          <Button variant={tone} onClick={onConfirm} disabled={busy}>{busy ? "…" : (confirmLabel ?? t("common.actions.confirm"))}</Button>
        </div>
      </div>
    </div>
  );
}
