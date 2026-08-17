import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../lib/format.js";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const tones: Record<Tone, string> = {
  neutral: "border-border text-muted bg-surface",
  accent: "border-accent/30 text-accent bg-accent-soft",
  success: "border-success/30 text-success bg-success-soft",
  warning: "border-warning/30 text-warning bg-warning-soft",
  danger: "border-danger/30 text-danger bg-danger-soft",
  info: "border-info/30 text-info bg-info-soft",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string | undefined }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center rounded-(--radius-1) border px-1.5 text-meta font-semibold uppercase tracking-[0.06em] whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** One status vocabulary for the whole application. */
function statusTone(state: string): Tone {
  switch (state.toUpperCase()) {
    case "PUBLISHED":
    case "COMPILED":
    case "COMPLETE":
    case "SATISFIED":
    case "VALIDATED":
    case "OK":
      return "success";
    case "IN_PROGRESS":
    case "IN PROGRESS":
    case "OPEN":
    case "ACTIONABLE":
      return "info";
    case "DRAFT":
    case "UNSAVED":
      return "warning";
    case "NOT_VALIDATED":
    case "UNAVAILABLE":
    case "ERROR":
    case "INVALID":
      return "danger";
    default:
      return "neutral";
  }
}

const knownStatuses = [
  "OPEN", "SATISFIED", "VALIDATED", "NOT_VALIDATED", "IN_PROGRESS", "COMPLETE", "UNAVAILABLE", "OK",
  "DRAFT", "INVALID", "COMPILING", "COMPILED", "PUBLISHED", "ADMITTED", "REFUSED", "ACTIONABLE", "UNSAVED",
  "ERROR", "CURRENT", "STARTING", "RUNNING", "SUCCEEDED", "FAILED", "ABORTED",
] as const;
type KnownStatus = (typeof knownStatuses)[number];
const isKnownStatus = (value: string): value is KnownStatus => (knownStatuses as readonly string[]).includes(value);

/** Display label of a runtime state; unknown states fall back to the raw value. */
export function StatusBadge({ state, className }: { state: string; className?: string }) {
  const { t } = useTranslation();
  const key = state.toUpperCase().replace(/ /g, "_");
  const label = isKnownStatus(key) ? t(`ui.status.${key}`) : state.replace(/_/g, " ");
  return <Badge tone={statusTone(state)} className={className}>{label}</Badge>;
}

export function Count({ value, className }: { value: number | string; className?: string }) {
  return (
    <span className={cx("inline-flex h-5 min-w-5 items-center justify-center rounded-(--radius-1) bg-surface-3 px-1.5 text-caption font-medium tabular-nums text-muted", className)}>
      {value}
    </span>
  );
}
