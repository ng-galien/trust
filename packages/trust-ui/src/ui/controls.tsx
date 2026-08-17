import { Search, X } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../lib/format.js";

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  size?: "sm" | "md";
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cx("inline-flex rounded-(--radius-2) border border-border bg-surface p-0.5", size === "sm" ? "h-7" : "h-8")}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-[calc(var(--radius-2)-2px)] px-2.5 text-body font-medium transition-colors",
              active ? "bg-surface-3 text-text" : "text-muted hover:text-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Labelled form row: label · optional hint, then the control(s). */
export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <div className="flex items-baseline gap-2"><span className="text-body-lg font-medium">{label}</span>{hint ? <span className="text-caption text-faint">{hint}</span> : null}</div>
      {children}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-8 rounded-(--radius-2) border border-border bg-surface px-2.5 text-ui text-text placeholder:text-faint focus:border-border-focus",
        className,
      )}
      {...rest}
    />
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  size = "md",
  className,
  autoFocus,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  size?: "sm" | "md";
  className?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <label className={cx("relative flex items-center", className)}>
      <Search size={14} className="pointer-events-none absolute left-2.5 text-faint" />
      <input
        aria-label={ariaLabel ?? placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cx(
          "w-full rounded-(--radius-2) border border-border bg-surface pl-8 pr-7 text-text placeholder:text-faint focus:border-border-focus",
          size === "sm" ? "h-7 text-body" : "h-8 text-ui",
        )}
      />
      {value ? (
        <button aria-label={t("ui.controls.clear")} onClick={() => onChange("")} className="absolute right-1.5 rounded p-0.5 text-faint hover:text-text">
          <X size={13} />
        </button>
      ) : null}
    </label>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-(--radius-1) border border-border bg-surface-2 px-1 text-micro text-muted">{children}</kbd>;
}

/** Hover / focus tooltip for icon-only controls. */
export function Tooltip({ label, side = "right", children }: { label: string; side?: "right" | "bottom"; children: ReactNode }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cx(
          "pointer-events-none absolute z-50 whitespace-nowrap rounded-(--radius-1) bg-surface-inverse px-2 py-1 text-caption font-medium text-inverse opacity-0 shadow-(--shadow-2) transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100",
          side === "right" ? "left-full top-1/2 ml-2 -translate-y-1/2" : "top-full left-1/2 mt-1.5 -translate-x-1/2",
        )}
      >
        {label}
      </span>
    </span>
  );
}
