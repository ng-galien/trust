import { i18next } from "../i18n/index.js";

export function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(i18next.language);
}

export function relativeTime(value: string) {
  const date = new Date(value).getTime();
  if (Number.isNaN(date)) return value;
  const minutes = Math.max(1, Math.round((Date.now() - date) / 60_000));
  if (minutes < 60) return i18next.t("common.time.minutesAgo", { count: minutes });
  if (minutes < 1_440) return i18next.t("common.time.hoursAgo", { count: Math.round(minutes / 60) });
  return i18next.t("common.time.daysAgo", { count: Math.round(minutes / 1_440) });
}

/** Counted noun from the `common.count` dictionary: `plural(3, "check")` → "3 checks". */
export function plural(count: number, noun: keyof CountNouns) {
  return i18next.t(`common.count.${noun}`, { count });
}
type CountNouns = { check: 0; checkCap: 0; plan: 0; dryRun: 0; operation: 0; procedure: 0; value: 0; credential: 0; verdict: 0; step: 0; scenario: 0; environment: 0; fact: 0; runnableOperation: 0; producedField: 0; otherCheck: 0; missingDeclaration: 0; line: 0 };

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}
