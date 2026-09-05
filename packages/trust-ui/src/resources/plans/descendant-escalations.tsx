import type { DescendantEscalation } from "@trust/extension-sdk";
import { ArrowUpRight, GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Markdown } from "../../ui/markdown.js";

/** The runtime supplies only active escalations in the current descendant subtree. */
export function DescendantEscalationCount({ escalations = [] }: { escalations?: readonly DescendantEscalation[] }) {
  const { t } = useTranslation();
  if (escalations.length === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-label font-medium text-warning"
      data-testid="descendant-escalation-count"
    >
      <GitBranch size={13} aria-hidden="true" />
      {t("plans.descendants.count", { count: escalations.length })}
    </span>
  );
}

export function DescendantEscalations({ escalations = [] }: { escalations?: readonly DescendantEscalation[] }) {
  const { t } = useTranslation();
  if (escalations.length === 0) return null;
  return (
    <section
      className="mt-3 border-l-2 border-warning pl-3"
      aria-labelledby="descendant-escalations-title"
      data-testid="descendant-escalations"
    >
      <h2 id="descendant-escalations-title" className="text-ui font-semibold text-warning">
        <DescendantEscalationCount escalations={escalations} />
      </h2>
      <p className="mt-1 text-label text-muted">{t("plans.descendants.explanation")}</p>
      <ul className="mt-2 max-h-72 overflow-y-auto divide-y divide-border">
        {escalations.map((escalation) => (
          <li key={escalation.escalationId} className="min-w-0 py-3 first:pt-1">
            <Link
              to={`${escalation.mode === "dry-run" ? "/dry-runs" : "/plans"}/${encodeURIComponent(escalation.plan)}?sel=${encodeURIComponent(`check:${escalation.checkUri}`)}`}
              className="inline-flex max-w-full items-center gap-1 text-body-lg font-medium text-accent hover:underline"
              aria-label={t("plans.descendants.open", { plan: escalation.title || escalation.plan })}
            >
              <span className="break-words">{escalation.title || escalation.plan}</span>
              <ArrowUpRight size={14} className="shrink-0" aria-hidden="true" />
            </Link>
            <p className="mono mt-1 break-all text-caption text-faint">
              {escalation.path
                .map((step) => step.parentPlan)
                .concat(escalation.plan)
                .join(" → ")}
            </p>
            <div className="mt-2 grid min-w-0 gap-3 lg:grid-cols-2">
              <div className="min-w-0">
                <h3 className="kicker mb-1">{t("plans.summary.blockingReason")}</h3>
                <Markdown>{escalation.blockingReason}</Markdown>
              </div>
              <div className="min-w-0">
                <h3 className="kicker mb-1">{t("plans.summary.forbiddenFurtherAction")}</h3>
                <Markdown>{escalation.forbiddenFurtherAction}</Markdown>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
