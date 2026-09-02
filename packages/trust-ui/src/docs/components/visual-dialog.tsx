import { Maximize2, X } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { cx } from "../../lib/format.js";

export function VisualExpandButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t("docs.visual.expand")}
      title={t("docs.visual.expand")}
      className={cx("absolute top-2 right-2 z-20 grid h-8 w-8 place-items-center rounded-full border border-border bg-surface/95 text-muted shadow-(--shadow-1) hover:text-text focus-visible:text-text", className)}
      onClick={(event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onClick(); }}
    >
      <Maximize2 size={15} />
    </button>
  );
}

export function VisualDialog({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const { t } = useTranslation();
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--color-overlay-backdrop)] p-4 sm:p-8" onClick={onClose}>
      <button ref={close} type="button" aria-label={t("common.actions.close")} title={t("common.actions.close")} className="absolute top-4 right-4 z-20 grid h-9 w-9 place-items-center rounded-full border border-border bg-surface text-text shadow-(--shadow-2)" onClick={onClose}>
        <X size={17} />
      </button>
      <div className="relative max-h-full max-w-full overflow-auto rounded-(--radius-3) border border-border bg-surface p-4 shadow-(--shadow-3)" onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
