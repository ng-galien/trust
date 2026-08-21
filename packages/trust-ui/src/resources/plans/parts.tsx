import { Activity, FlaskConical, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { PlanMode } from "../../types.js";
import { Badge, StatusBadge } from "../../ui/badge.js";

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

/** Work state first (In progress / Complete); a closed or expired Session is a second, quieter badge —
    expected on a complete Plan, a warning while work remains (the agent cannot admit anything). */
export function PlanStateBadges({ workState, sessionState }: { workState: "IN_PROGRESS" | "COMPLETE"; sessionState: "OPEN" | "UNAVAILABLE" }) {
  const { t } = useTranslation();
  return (
    <>
      <StatusBadge state={workState} />
      {sessionState === "UNAVAILABLE" ? (
        <span title={workState === "COMPLETE" ? t("plans.session.closedCompleteHint") : t("plans.session.closedHint")}>
          <Badge tone={workState === "COMPLETE" ? "neutral" : "warning"} className="inline-flex items-center gap-1"><LockKeyhole size={11} /> {t("plans.session.closed")}</Badge>
        </span>
      ) : null}
    </>
  );
}
