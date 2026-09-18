import "./delegation.css";
import type { PlanSummaryView, PlanView } from "@trust/extension-sdk";
import { ArrowUpRight, History } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { cx } from "../../lib/format.js";
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
  const byId = new Map(plans.map((plan) => [plan.plan, plan]));
  let rootId = selected;
  const ancestry = new Set([selected]);
  while (byId.get(rootId)?.parent?.plan) {
    const parentId = byId.get(rootId)?.parent?.plan;
    if (!parentId || !byId.has(parentId) || ancestry.has(parentId)) break;
    ancestry.add(parentId);
    rootId = parentId;
  }
  const root = usePlan(rootId);
  const [selection, setSelection] = useState<string | null>(null);
  const descendants: PlanSummaryView[] = [];
  const visit = (id: string, path: string[]) => {
    for (const plan of plans.filter((item) => item.parent?.plan === id)) {
      if (path.includes(plan.plan)) continue;
      descendants.push(plan);
      visit(plan.plan, [...path, plan.plan]);
    }
  };
  visit(rootId, [rootId]);
  const active =
    selection && (selection === rootId || descendants.some((plan) => plan.plan === selection))
      ? selection
      : selected === rootId
        ? (descendants[0]?.plan ?? rootId)
        : selected;
  const parent = byId.get(rootId);
  const selectedPlan = byId.get(selected);
  return (
    <Overlay
      onClose={onClose}
      labelledBy="delegation-summary-title"
      breadcrumb={
        <Breadcrumb
          items={[
            { label: "TRUST", to: "/overview" },
            { label: t("delegation.title"), to: "/delegation" },
            { label: parent?.metadata.title ?? parent?.procedure ?? rootId },
            ...(selected !== rootId ? [{ label: selectedPlan?.procedure ?? selected, mono: true }] : []),
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
            <p className="delegation-worklist-label">{t("delegation.work")}</p>
            {parent && (
              <ul className="delegation-tree">
                <WorkBranch
                  plan={parent}
                  plans={plans}
                  active={active}
                  onSelect={setSelection}
                  path={[rootId]}
                  rootTitle
                />
              </ul>
            )}
            {root.data?.invocations.some((item) => !item.childPlan) && (
              <div className="delegation-waiting">
                {root.data.invocations
                  .filter((item) => !item.childPlan)
                  .map((item) => (
                    <div key={item.id} className="delegation-waiting-item">
                      <p className="font-medium">{item.name}</p>
                      <p className="text-caption text-muted">{item.blockedBy.join(" · ") || t("delegation.waiting")}</p>
                    </div>
                  ))}
              </div>
            )}
          </nav>
          <WorkInspector key={active} plan={active} />
        </div>
      )}
    </Overlay>
  );
}

function WorkBranch({
  plan,
  plans,
  active,
  onSelect,
  path,
  rootTitle = false,
}: {
  plan: PlanSummaryView;
  plans: PlanSummaryView[];
  active: string;
  onSelect: (plan: string) => void;
  path: string[];
  rootTitle?: boolean;
}) {
  const children = plans.filter((item) => item.parent?.plan === plan.plan && !path.includes(item.plan));
  return (
    <li className="delegation-tree-node">
      <WorkItem plan={plan} active={active === plan.plan} onSelect={() => onSelect(plan.plan)} rootTitle={rootTitle} />
      {children.length > 0 && (
        <ul className="delegation-tree-children">
          {children.map((child) => (
            <WorkBranch
              key={child.plan}
              plan={child}
              plans={plans}
              active={active}
              onSelect={onSelect}
              path={[...path, child.plan]}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function WorkItem({
  plan,
  active,
  onSelect,
  rootTitle = false,
}: {
  plan: PlanSummaryView;
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
    >
      <span className="min-w-0">
        <span className="block text-ui font-semibold">{title}</span>
        <span className="delegation-workitem-status">
          <StatusBadge state={plan.workState} className="delegation-workitem-state" />
          {plan.parent && !plan.parent.current && (
            <span className="text-caption font-normal text-muted">{t("delegation.superseded")}</span>
          )}
        </span>
      </span>
    </Button>
  );
}

function WorkInspector({ plan }: { plan: string }) {
  const { t } = useTranslation();
  const detail = usePlan(plan);
  const compiled = useWorkDefinition(plan, detail.data);
  const catalog = useProcedures();
  const [history, setHistory] = useState(false);
  const [procedureSource, setProcedureSource] = useState(false);
  const [selectedCheck, setSelectedCheck] = useState<string | null | undefined>();
  if (detail.isLoading) return <LoadingState />;
  if (detail.error) return <ErrorBox message={detail.error.message} />;
  const checks = detail.data?.checks ?? [];
  const title = compiled?.title ?? detail.data?.metadata.title ?? detail.data?.procedure;
  const procedure = detail.data?.procedure;
  const version = detail.data?.procedureVersion;
  const published = catalog.data?.some(
    ({ procedure: item }) => item.procedure === procedure && item.version === version,
  );
  return (
    <article aria-label={t("delegation.detail")} data-work-detail={plan} className="delegation-inspector">
      <div className="delegation-inspector-content">
        <header className="delegation-inspector-heading">
          <h2 className="text-heading font-semibold text-text">{title}</h2>
          {procedure && (
            <p className="mono delegation-procedure-name text-caption text-muted">
              {procedure}
              {version ? `@${version}` : ""}
            </p>
          )}
          <details className="delegation-technical-id text-caption text-muted">
            <summary className="cursor-pointer">{t("delegation.technicalId")}</summary>
            <code className="block break-all pt-1">{plan}</code>
          </details>
          <div className="delegation-actions">
            <Link
              className="inline-flex h-8 items-center gap-1.5 rounded-(--radius-2) border border-border bg-surface px-3 text-ui font-medium hover:bg-surface-2"
              to={`/plans/${encodeURIComponent(plan)}`}
            >
              <ArrowUpRight size={15} />
              {t("delegation.open")}
            </Link>
            {published && procedure && (
              <Link
                className="inline-flex h-8 items-center gap-1.5 rounded-(--radius-2) border border-border bg-surface px-3 text-ui font-medium hover:bg-surface-2"
                to={`/procedures/${encodeURIComponent(procedure)}?version=${encodeURIComponent(version ?? "")}`}
              >
                <ArrowUpRight size={15} />
                {t("delegation.openProcedure")}
              </Link>
            )}
            {catalog.data && !published && compiled?.source && (
              <Button
                variant="secondary"
                aria-expanded={procedureSource}
                onClick={() => setProcedureSource(!procedureSource)}
              >
                {t("delegation.pinnedProcedure")}
              </Button>
            )}
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
        {procedureSource && compiled?.source && (
          <section className="mb-5 rounded-(--radius-2) border border-border bg-surface-2 p-3">
            <h3 className="text-ui font-semibold">{t("delegation.pinnedProcedure")}</h3>
            <p className="mt-1 text-caption text-muted">{t("delegation.inlineProcedureHint")}</p>
            <pre className="mono mt-3 max-h-[50vh] overflow-auto whitespace-pre text-caption">{compiled.source}</pre>
          </section>
        )}
        {history && detail.data && <PlanHistory plan={detail.data} />}
        {!history && (
          <>
            {checks.length === 0 && <p className="text-body text-muted">{t("delegation.noChecks")}</p>}
            {checks.map((check) => (
              <section key={check.checkUri} className="delegation-check">
                {checks.length > 1 && <h3 className="text-subhead font-semibold">{check.name}</h3>}
                <div className="delegation-result">
                  <div className="delegation-result-heading">
                    <h3>{t("delegation.observed")}</h3>
                    {check.latestVerdict && (
                      <span className="delegation-verdict">{t(`ui.status.${check.latestVerdict}`)}</span>
                    )}
                  </div>
                  <p>{check.reason ?? t("delegation.noResult")}</p>
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
        <div className="delegation-inspector-checklist">
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
export function useWorkDefinition(id: string, view: PlanView | undefined) {
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
