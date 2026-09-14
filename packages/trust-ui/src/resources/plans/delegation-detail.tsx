import "./delegation.css";
import type { PlanSummaryView, PlanView } from "@trust/extension-sdk";
import { ArrowUpRight, History } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { cx } from "../../lib/format.js";
import { useExpert } from "../../lib/preferences.js";
import { usePlan, useProcedures } from "../../lib/runtime-context.js";
import { StatusBadge } from "../../ui/badge.js";
import { Breadcrumb } from "../../ui/breadcrumb.js";
import { Button } from "../../ui/button.js";
import { Overlay } from "../../ui/overlay.js";
import { ErrorBox, LoadingState } from "../../ui/states.js";
import { OverlayHeader } from "../shared/resource-overlay.js";
import { PlanChecklist } from "./plan-checklist.js";
import { PlanHistory } from "./plan-overlay.js";

export function DelegationDetail({
  selected,
  plans,
  onClose,
}: {
  selected: string;
  plans: PlanSummaryView[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const root = usePlan(selected);
  const [selection, setSelection] = useState<string | null>(null);
  const descendants: { plan: PlanSummaryView; depth: number }[] = [];
  const visit = (id: string, depth: number, path: string[]) => {
    for (const plan of plans.filter((item) => item.parent?.plan === id)) {
      if (path.includes(plan.plan)) continue;
      descendants.push({ plan, depth });
      visit(plan.plan, depth + 1, [...path, plan.plan]);
    }
  };
  visit(selected, 0, [selected]);
  const active =
    selection && (selection === selected || descendants.some(({ plan }) => plan.plan === selection))
      ? selection
      : (descendants[0]?.plan.plan ?? selected);
  const parent = plans.find((plan) => plan.plan === selected);
  return (
    <Overlay
      onClose={onClose}
      labelledBy="delegation-summary-title"
      breadcrumb={
        <Breadcrumb
          items={[
            { label: "TRUST", to: "/overview" },
            { label: t("delegation.title"), to: "/delegation" },
            { label: selected, mono: true },
          ]}
        />
      }
    >
      <OverlayHeader
        labelledBy="delegation-summary-title"
        kicker={t("delegation.title")}
        badges={parent && <StatusBadge state={parent.workState} />}
        id=""
        title={root.data?.metadata.title ?? parent?.metadata.title ?? root.data?.procedure ?? t("delegation.title")}
      />
      {root.isLoading ? (
        <LoadingState />
      ) : root.error ? (
        <ErrorBox message={root.error.message} />
      ) : (
        <div className="delegation-workspace">
          <nav aria-label={t("delegation.work")} className="delegation-worklist">
            {parent && (
              <WorkItem
                plan={parent}
                depth={0}
                active={active === selected}
                onSelect={() => setSelection(selected)}
                rootTitle
              />
            )}
            <div className="ml-3 border-l border-border pl-2">
              {descendants.map(({ plan, depth }) => (
                <WorkItem
                  key={plan.plan}
                  plan={plan}
                  depth={depth + 1}
                  active={active === plan.plan}
                  onSelect={() => setSelection(plan.plan)}
                />
              ))}
              {root.data?.invocations
                .filter((item) => !item.childPlan)
                .map((item) => (
                  <div key={item.id} className="px-3 py-3 text-body">
                    <p className="font-medium">{item.name}</p>
                    <p className="mt-1 text-caption text-muted">
                      {item.blockedBy.join(" · ") || t("delegation.waiting")}
                    </p>
                  </div>
                ))}
            </div>
          </nav>
          <WorkInspector key={active} plan={active} />
        </div>
      )}
    </Overlay>
  );
}

function WorkItem({
  plan,
  depth,
  active,
  onSelect,
  rootTitle = false,
}: {
  plan: PlanSummaryView;
  depth: number;
  active: boolean;
  onSelect: () => void;
  rootTitle?: boolean;
}) {
  const { t } = useTranslation();
  const detail = usePlan(plan.plan);
  const definition = useWorkDefinition(plan.plan, detail.data);
  const title = rootTitle
    ? (plan.metadata.title ?? definition?.title ?? plan.procedure)
    : (definition?.title ?? plan.metadata.title ?? plan.procedure);
  return (
    <Button
      variant="ghost"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      data-plan={plan.plan}
      className={cx("delegation-workitem", active && "delegation-workitem-selected")}
      style={{ paddingLeft: 12 + depth * 20 }}
    >
      <span className="min-w-0">
        <span className="block text-ui font-semibold">{title}</span>
        <span className="mt-1 block text-caption font-normal text-muted">
          {t(`ui.status.${plan.workState}`)}
          {plan.parent && !plan.parent.current ? ` · ${t("delegation.superseded")}` : ""}
        </span>
      </span>
    </Button>
  );
}

function WorkInspector({ plan }: { plan: string }) {
  const { t } = useTranslation();
  const detail = usePlan(plan);
  const navigate = useNavigate();
  const expert = useExpert();
  const compiled = useWorkDefinition(plan, detail.data);
  const [history, setHistory] = useState(false);
  const [selectedCheck, setSelectedCheck] = useState<string | null | undefined>();
  if (detail.isLoading) return <LoadingState />;
  if (detail.error) return <ErrorBox message={detail.error.message} />;
  const checks = detail.data?.checks ?? [];
  const title = compiled?.title ?? detail.data?.metadata.title ?? detail.data?.procedure;
  return (
    <article aria-label={t("delegation.detail")} data-work-detail={plan} className="delegation-inspector">
      <div className="delegation-inspector-content">
        <header className="delegation-inspector-heading">
          <h2 className="text-heading font-semibold text-text">{title}</h2>
          {expert && <p className="mt-2 break-all text-caption text-muted">{plan}</p>}
          <div className="delegation-actions">
            <Button icon={<ArrowUpRight size={15} />} onClick={() => navigate(`/plans/${encodeURIComponent(plan)}`)}>
              {t("delegation.open")}
            </Button>
            <Button
              variant="ghost"
              icon={<History size={15} />}
              aria-pressed={history}
              onClick={() => setHistory(!history)}
            >
              {t("delegation.history")}
            </Button>
          </div>
        </header>
        {history && detail.data && <PlanHistory plan={detail.data} />}
        {!history && (
          <>
            {checks.length === 0 && <p className="text-body text-muted">{t("delegation.noChecks")}</p>}
            {checks.map((check) => (
              <section key={check.checkUri} className="delegation-check">
                {checks.length > 1 && <h3 className="text-subhead font-semibold">{check.name}</h3>}
                <div className="delegation-result">
                  <h3>{t("delegation.observed")}</h3>
                  <p>{check.reason ?? t("delegation.noResult")}</p>
                  {check.latestVerdict && (
                    <span className="delegation-verdict">{t(`ui.status.${check.latestVerdict}`)}</span>
                  )}
                </div>
                {check.successReason !== check.reason && (
                  <div className="delegation-fact">
                    <h3>{t("delegation.expected")}</h3>
                    <p>{check.successReason}</p>
                  </div>
                )}
                {!!check.blockedBy.length && (
                  <div className="delegation-fact">
                    <h3>{t("delegation.blocked")}</h3>
                    <ul>
                      {check.blockedBy.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            ))}
          </>
        )}
      </div>
      {!history && detail.data && checks.length > 0 && (
        <div className="mt-6 min-h-[360px] flex-1 border-t border-border">
          <PlanChecklist
            plan={detail.data}
            compiled={compiled}
            selected={selectedCheck === undefined ? `check:${checks[0]?.checkUri}` : (selectedCheck ?? undefined)}
            onSelect={(value) => setSelectedCheck(value ?? null)}
          />
        </div>
      )}
    </article>
  );
}

/** Resolve pinned inline mission titles and scenarios through the existing runtime projection. */
function useWorkDefinition(id: string, view: PlanView | undefined) {
  const owner = usePlan(view?.parent?.plan ?? id);
  const catalog = useProcedures();
  const mission = owner.data?.invocations.find(
    (item) => item.childPlan === id || item.history.some((generation) => generation.childPlan === id),
  )?.mission;
  const inline = mission
    ? owner.data?.resolvedMissions?.[mission.collection]?.find((item) => item.id === mission.id)?.procedure
    : undefined;
  return (
    inline ??
    catalog.data?.find(
      ({ procedure }) => procedure.procedure === view?.procedure && procedure.version === view?.procedureVersion,
    )?.procedure
  );
}
