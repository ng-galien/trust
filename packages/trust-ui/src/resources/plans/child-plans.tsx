import type { PlanView } from "@trust/extension-sdk";
import { ArrowUpLeft, ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

export function ChildPlans({ plan }: { plan: PlanView }) {
  const { t } = useTranslation();
  const href = (id: string) => `${plan.mode === "dry-run" ? "/dry-runs" : "/plans"}/${encodeURIComponent(id)}`;
  if (!plan.parent && !plan.invocations?.length) return null;
  return (
    <section className="mt-3 border-t border-border pt-2" aria-label={t("plans.children.title")}>
      {plan.parent ? (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-label">
          <Link className="inline-flex items-center gap-1 text-accent hover:underline" to={href(plan.parent.plan)}>
            <ArrowUpLeft size={13} aria-hidden="true" />
            {t("plans.children.parent")}: {plan.parent.plan}
          </Link>
          <span className={plan.parent.current ? "text-muted" : "text-warning"}>
            {t(plan.parent.current ? "plans.children.current" : "plans.children.superseded", {
              generation: plan.parent.generation,
            })}
          </span>
        </div>
      ) : null}
      {!!plan.invocations?.length && (
        <>
          <h2 className="kicker">{t("plans.children.title")}</h2>
          <ul className="mt-1 max-h-48 overflow-y-auto divide-y divide-border">
            {plan.invocations.map((invocation) => (
              <li key={invocation.id} className="min-w-0 py-2 text-label">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {invocation.childPlan ? (
                    <Link
                      className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                      to={href(invocation.childPlan)}
                      aria-label={t("plans.children.open", { name: invocation.name })}
                    >
                      {invocation.name}
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </Link>
                  ) : (
                    <span className="font-medium">{invocation.name}</span>
                  )}
                  <span className="text-muted">
                    {t(`plans.children.${invocation.state}`)}
                    {invocation.generation !== null
                      ? ` · ${t("plans.children.generation", { generation: invocation.generation })}`
                      : ""}
                  </span>
                </div>
                {invocation.blockedBy.length > 0 ? (
                  <ul className="mt-1 text-muted">
                    {Array.from(new Set(invocation.blockedBy)).map((reason) => (
                      <li key={reason} className="break-words">
                        {reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {invocation.history.some((generation) => generation.supersededAt !== null) ? (
                  <details className="mt-1 text-faint">
                    <summary className="cursor-pointer">{t("plans.children.history")}</summary>
                    <ul>
                      {invocation.history
                        .filter((generation) => generation.supersededAt !== null)
                        .map((generation) => (
                          <li key={generation.generation}>
                            <Link className="text-accent hover:underline" to={href(generation.childPlan)}>
                              {t("plans.children.superseded", { generation: generation.generation })}
                            </Link>
                          </li>
                        ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
