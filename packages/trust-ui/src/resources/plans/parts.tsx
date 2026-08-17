import { Activity, FlaskConical } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { PlanMode } from "../../types.js";
import { Badge } from "../../ui/badge.js";

/* Small Plan bricks composed by the home, the overlay, the engagement form and the cockpit. */

export function ModeBadge({ mode }: { mode: PlanMode }) {
  const { t } = useTranslation();
  return mode === "dry-run"
    ? <Badge tone="warning" className="inline-flex items-center gap-1"><FlaskConical size={11} /> {t("plans.mode.dryRun")}</Badge>
    : <Badge tone="info" className="inline-flex items-center gap-1"><Activity size={11} /> {t("plans.mode.live")}</Badge>;
}

export function ProgressBar({ satisfied, total, className }: { satisfied: number; total: number; className?: string }) {
  const { t } = useTranslation();
  const ratio = total ? satisfied / total : 0;
  return (
    <span className={`inline-flex items-center gap-2 text-label text-muted ${className ?? ""}`} title={t("plans.progress.title", { satisfied, total })}>
      <span className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-surface-3"><span className={`block h-full rounded-full ${ratio === 1 ? "bg-success" : "bg-accent"}`} style={{ width: `${ratio * 100}%` }} /></span>
      {satisfied}/{total}
    </span>
  );
}
