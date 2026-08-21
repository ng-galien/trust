import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../lib/format.js";
import { Popover } from "./menu.js";

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
}

/** Non-native single select: button + popover list, keyboard dismissable, themed by tokens. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  className,
  size = "md",
  align = "start",
}: {
  value: T | "";
  onChange: (value: T) => void;
  options: Array<SelectOption<T>>;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  size?: "sm" | "md";
  align?: "start" | "end";
}) {
  const { t } = useTranslation();
  const current = options.find((option) => option.value === value);
  return (
    <Popover
      align={align}
      className={className}
      panelClassName="p-1"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
          className={cx(
            "flex w-full items-center gap-2 rounded-(--radius-2) border bg-surface px-2.5 text-left text-text hover:border-border-strong",
            size === "sm" ? "h-7 text-body" : "h-8 text-body-lg",
            open ? "border-border-focus" : "border-border",
          )}
        >
          <span className={cx("min-w-0 flex-1 truncate-1", !current && "text-faint")}>{current?.label ?? placeholder ?? t("ui.select.placeholder")}</span>
          <ChevronDown size={13} className={cx("shrink-0 text-muted transition-transform", open && "rotate-180")} />
        </button>
      )}
    >
      {(close) => (
        <ul role="listbox" aria-label={ariaLabel} className="max-h-72 overflow-y-auto">
          {options.map((option) => {
            const active = option.value === value;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={option.disabled}
                  onClick={() => {
                    onChange(option.value);
                    close();
                  }}
                  className={cx(
                    "flex w-full items-center gap-2 rounded-(--radius-1) px-2 py-1.5 text-left text-body-lg hover:bg-surface-2 disabled:opacity-40",
                    active ? "text-text" : "text-text",
                  )}
                >
                  <span className="inline-flex w-3.5 justify-center text-accent">{active ? <Check size={12} /> : null}</span>
                  <span className="min-w-0 flex-1 truncate-1">{option.label}</span>
                  {option.meta ? <span className="text-caption text-faint">{option.meta}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Popover>
  );
}
