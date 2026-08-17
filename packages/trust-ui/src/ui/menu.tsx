import { type ReactNode, useCallback, useRef, useState } from "react";

import { cx } from "../lib/format.js";
import { useDismiss } from "../lib/use-dismiss.js";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  separator?: boolean;
}

/** Popover menu anchored to its trigger; closes on outside click, Escape and selection. */
export function Menu({
  trigger,
  items,
  align = "end",
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, root, close);

  return (
    <div ref={root} className={cx("relative inline-flex", className)}>
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open ? (
        <div
          role="menu"
          className={cx(
            "absolute top-full z-50 mt-1 min-w-40 rounded-(--radius-2) border border-border bg-surface p-1 shadow-(--shadow-2)",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((item, index) =>
            item.separator ? (
              <div key={`sep-${index}`} className="my-1 h-px bg-border" />
            ) : (
              <button
                key={item.label}
                role="menuitem"
                disabled={item.disabled}
                title={item.disabled ? item.disabledReason : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
                className={cx(
                  "flex w-full items-center gap-2 rounded-(--radius-1) px-2 py-1.5 text-left text-body-lg hover:bg-surface-2 disabled:opacity-45 disabled:hover:bg-transparent",
                  item.danger ? "text-danger" : "text-text",
                )}
              >
                {item.icon ? <span className="text-muted">{item.icon}</span> : null}
                <span className="flex-1">{item.label}</span>
                {item.disabled && item.disabledReason ? <span className="text-micro text-faint">{item.disabledReason}</span> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Anchored popover with arbitrary content; same dismissal rules as Menu. */
export function Popover({
  trigger,
  children,
  align = "end",
  className,
  panelClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  className?: string | undefined;
  panelClassName?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, root, close);

  return (
    <div ref={root} className={cx("relative inline-flex", className)}>
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open ? (
        <div className={cx("absolute top-full z-50 mt-1 rounded-(--radius-2) border border-border bg-surface shadow-(--shadow-2)", align === "end" ? "right-0" : "left-0", panelClassName)}>
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      ) : null}
    </div>
  );
}

/** Radio-like option row for popover panels. */
export function OptionRow({ active, onSelect, children, meta }: { active: boolean; onSelect: () => void; children: ReactNode; meta?: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onSelect}
      className={cx("flex w-full items-center gap-2 rounded-(--radius-1) px-2 py-1.5 text-left text-body-lg hover:bg-surface-2", active ? "text-text" : "text-muted")}
    >
      <span className={cx("inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border", active ? "border-accent" : "border-border-strong")}>
        {active ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
      </span>
      <span className="flex-1">{children}</span>
      {meta ? <span className="text-caption text-faint">{meta}</span> : null}
    </button>
  );
}
