import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cx } from "../lib/format.js";
import { useDismiss } from "../lib/use-dismiss.js";

export interface MenuItem {
  label: string;
  /** One line explaining what the item does, shown under its label. */
  description?: string;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
}

/** Divider between groups of menu items. */
export const menuSeparator = { separator: true } as const;
export type MenuEntry = MenuItem | typeof menuSeparator;

/** Attributes the trigger spreads so assistive technology announces the menu it opens. */
export interface MenuTriggerProps {
  open: boolean;
  toggle: () => void;
  attributes: { "aria-haspopup": "menu"; "aria-expanded": boolean };
}

/** Fixed position of a surface anchored to its trigger: below it, or above when there is no room below. */
function useAnchoredPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  surface: RefObject<HTMLElement | null>,
  align: "start" | "end",
): CSSProperties | undefined {
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    const update = () => {
      const trigger = anchor.current?.getBoundingClientRect();
      const panel = surface.current?.getBoundingClientRect();
      if (!trigger || !panel) return;
      const gutter = 8;
      const gap = 4;
      const width = Math.max(trigger.width, panel.width);
      const left = align === "end" ? trigger.right - width : trigger.left;
      const below = trigger.bottom + gap;
      const above = trigger.top - panel.height - gap;
      setPosition({
        position: "fixed",
        top: below + panel.height <= window.innerHeight - gutter || above < gutter ? below : above,
        left: Math.min(Math.max(gutter, left), Math.max(gutter, window.innerWidth - width - gutter)),
        minWidth: trigger.width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [align, anchor, open, surface]);
  return position;
}

/**
 * Menu anchored to its trigger and rendered above the page, so no scrolling or clipped container hides it. It opens
 * above the trigger near the bottom of the viewport and moves focus to its first item; arrow keys, Home and End move
 * between items; Escape, Tab, outside click and selection close it and return focus to the trigger.
 */
export function Menu({
  label,
  trigger,
  items,
  align = "end",
  className,
}: {
  /** Accessible name of the menu, usually the trigger's label. */
  label: string;
  trigger: (props: MenuTriggerProps) => ReactNode;
  items: MenuEntry[];
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    root.current?.querySelector<HTMLElement>("button, a")?.focus();
  }, []);
  useDismiss(open, root, close, panel);
  const position = useAnchoredPosition(open, root, panel, align);
  const enabledItems = () => [
    ...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []),
  ];
  const focusItem = (target: "first" | "last" | 1 | -1) => {
    const entries = enabledItems();
    if (!entries.length) return;
    if (target === "first") return entries[0]?.focus();
    if (target === "last") return entries[entries.length - 1]?.focus();
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    entries[(index + target + entries.length) % entries.length]?.focus();
  };
  const placed = position !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves once, when the placed menu appears
  useLayoutEffect(() => {
    if (open && placed) focusItem("first");
  }, [open, placed]);
  return (
    <div ref={root} className={cx("relative inline-flex", className)}>
      {trigger({
        open,
        toggle: () => setOpen((value) => !value),
        attributes: { "aria-haspopup": "menu", "aria-expanded": open },
      })}
      {open
        ? createPortal(
            <div
              ref={panel}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              style={position ?? { position: "fixed", visibility: "hidden" }}
              onKeyDown={(event) => {
                const keys: Record<string, "first" | "last" | 1 | -1> = {
                  ArrowDown: 1,
                  ArrowUp: -1,
                  Home: "first",
                  End: "last",
                };
                const target = keys[event.key];
                if (target !== undefined) {
                  event.preventDefault();
                  focusItem(target);
                } else if (event.key === "Tab") {
                  event.preventDefault();
                  close();
                }
              }}
              className="z-50 max-w-[22rem] min-w-44 rounded-(--radius-2) border border-border bg-surface p-1 shadow-(--shadow-2)"
            >
              {items.map((item, index) =>
                "separator" in item ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity besides their position
                  <hr key={`separator-${index}`} className="my-1 h-px border-0 bg-border" />
                ) : (
                  <button
                    type="button"
                    key={item.label}
                    role="menuitem"
                    disabled={item.disabled}
                    title={item.disabled ? item.disabledReason : undefined}
                    onClick={() => {
                      close();
                      item.onSelect?.();
                    }}
                    className={cx(
                      "flex w-full items-start gap-2 rounded-(--radius-1) px-2 py-1.5 text-left text-body-lg hover:bg-surface-2 focus:bg-surface-2 focus:outline-none disabled:opacity-45 disabled:hover:bg-transparent",
                      item.danger ? "text-danger" : "text-text",
                    )}
                  >
                    {item.icon ? <span className="mt-0.5 text-muted">{item.icon}</span> : null}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{item.label}</span>
                      {item.description ? <span className="text-caption text-muted">{item.description}</span> : null}
                      {item.disabled && item.disabledReason ? (
                        <span className="text-caption text-faint">{item.disabledReason}</span>
                      ) : null}
                    </span>
                  </button>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
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
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, root, close, panel);
  const position = useAnchoredPosition(open, root, panel, align);

  return (
    <div ref={root} className={cx("relative inline-flex", className)}>
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open
        ? createPortal(
            <div
              ref={panel}
              style={position ?? { position: "fixed", visibility: "hidden" }}
              className={cx(
                "z-50 rounded-(--radius-2) border border-border bg-surface shadow-(--shadow-2)",
                panelClassName,
              )}
            >
              {typeof children === "function" ? children(() => setOpen(false)) : children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Radio-like option row for popover panels. */
export function OptionRow({
  active,
  onSelect,
  children,
  meta,
}: {
  active: boolean;
  onSelect: () => void;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onSelect}
      className={cx(
        "flex w-full items-center gap-2 rounded-(--radius-1) px-2 py-1.5 text-left text-body-lg hover:bg-surface-2",
        active ? "text-text" : "text-muted",
      )}
    >
      <span
        className={cx(
          "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
          active ? "border-accent" : "border-border-strong",
        )}
      >
        {active ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
      </span>
      <span className="flex-1">{children}</span>
      {meta ? <span className="text-caption text-faint">{meta}</span> : null}
    </button>
  );
}
