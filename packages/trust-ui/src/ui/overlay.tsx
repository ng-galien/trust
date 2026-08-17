import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../lib/format.js";
import { IconButton } from "./button.js";
import { Kbd } from "./controls.js";

/** Item surface rendered on top of its collection inside the content area.
    Escape, the close control and the backdrop all call `onClose`. */
export function Overlay({
  onClose,
  breadcrumb,
  children,
  labelledBy,
  className,
}: {
  onClose: () => void;
  breadcrumb: ReactNode;
  children: ReactNode;
  labelledBy: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-30 flex items-stretch justify-center bg-[var(--color-overlay-backdrop)] p-2 md:p-3" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cx(
          "overlay-enter flex w-full max-w-(--content-max) flex-col overflow-hidden rounded-(--radius-3) border border-border bg-surface shadow-(--shadow-3) outline-none",
          className,
        )}
      >
        <div className="flex h-8 shrink-0 items-center justify-between gap-4 border-b border-border px-3">
          <div className="min-w-0 text-label text-muted">{breadcrumb}</div>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1 text-caption text-faint sm:inline-flex"><Kbd>Esc</Kbd> {t("ui.overlay.escToClose")}</span>
            <IconButton size="sm" label={t("common.actions.close")} onClick={onClose}><X size={15} /></IconButton>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}
