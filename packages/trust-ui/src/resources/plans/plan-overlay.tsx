import { useQueryClient } from "@tanstack/react-query";
import { parseGherkin, tokenizeSentence } from "@trust/gherkin";
import { ArrowDown, ArrowUp, CheckCircle2, ChevronRight, FileCode2, FlaskConical, History, ListChecks, LockKeyhole, Network, Pause, Play, RotateCcw, Server, Trash2, Workflow, XCircle } from "lucide-react";
import type { TFunction } from "i18next";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router";

import { cx, plural, relativeTime } from "../../lib/format.js";
import { useCurrentEnvironment } from "../../lib/environment.js";
import { mutationError, mutationErrorDetails, useClosePlan, useRemovePlan, useResetPlan } from "../../lib/mutations.js";
import { useCheck, usePlan, useProcedures, useRuntime } from "../../lib/runtime-context.js";
import type { CompiledProcedure, PlanCheck, PlanMode, PlanView } from "../../types.js";
import { Badge, StatusBadge } from "../../ui/badge.js";
import { Button, IconButton } from "../../ui/button.js";
import { type EditorDecoration, GherkinEditor } from "../../gherkin-editor.js";
import { type ChecklistOrder, updatePreferences, useExpert, usePreference, useResolvedTheme } from "../../lib/preferences.js";
import { ConfirmDialog } from "../../ui/confirm.js";
import { Description } from "../../ui/description.js";
import { Expert } from "../../ui/expert.js";
import { EmptyState, ErrorBox, LoadingState } from "../../ui/states.js";
import { useCloseTo, useOrigin } from "../shared/origin.js";
import { stripEphemeral, useOverlayViewState } from "../shared/overlay-state.js";
import { ResourceOverlay } from "../shared/resource-overlay.js";
import { ProcedureGraph } from "../procedures/procedure-graph.js";
import { PlanCockpit } from "./plan-console.js";
import { PlanEngage } from "./plan-engage.js";
import { orderedChecks } from "./model.js";
import { ModeBadge, PlanStateBadges, ProgressBar } from "./parts.js";

type Tab = "checklist" | "graph" | "source" | "history";
const TABS: readonly Tab[] = ["checklist", "graph", "source", "history"];

/* One overlay for live Plans (`/plans`) and dry-runs (`/dry-runs`): same object, same views.
   A dry-run adds a cockpit docked beside every view (declarations, next Check, verdict) — the views
   themselves are exactly what an agent-driven Plan shows. The interface never admits or finalizes a live Check. */
export function PlanOverlay({ planMode, mode = "item" }: { planMode: PlanMode; mode?: "item" | "new" }) {
  const params = useParams();
  const location = useLocation();
  const base = planMode === "dry-run" ? "/dry-runs" : "/plans";
  const listSearch = useMemo(() => stripEphemeral(location.search), [location.search]);
  const close = useCloseTo(`${base}${listSearch}`);
  if (mode === "new") return <PlanEngage planMode={planMode} base={base} onClose={close} listSearch={listSearch} />;
  return <PlanItem slug={decodeURIComponent(params.plan ?? "")} planMode={planMode} base={base} onClose={close} listSearch={listSearch} />;
}

function PlanItem({ slug, planMode, base, onClose, listSearch }: { slug: string; planMode: PlanMode; base: string; onClose: () => void; listSearch: string }) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const origin = useOrigin();
  const plan = usePlan(slug);
  const procedures = useProcedures();
  const view = useOverlayViewState<Tab>(TABS, "checklist");
  const { tab, setTab, sel, setSel } = view;
  const data = plan.data;
  const compiled: CompiledProcedure | undefined = useMemo(
    () => procedures.data?.find(({ procedure }) => procedure.procedure === data?.procedure && procedure.version === data?.procedureVersion)?.procedure,
    [procedures.data, data?.procedure, data?.procedureVersion],
  );
  const invalidate = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["plan", slug] }), queryClient.invalidateQueries({ queryKey: ["plans"] })]);
  const dryRun = data?.mode === "dry-run";
  const expert = useExpert();
  const cockpitOpen = usePreference("cockpitOpen");
  const cockpitWidth = usePreference("cockpitWidth");
  const setCockpitOpen = (open: boolean) => updatePreferences({ cockpitOpen: open });
  // A plan reached under the wrong anchor (a dry-run under /plans or the reverse) is shown, but never mixed in the lists.
  const notFound = plan.isError;
  const crumbs = [{ label: t("plans.brand"), to: "/overview" }, { label: planMode === "dry-run" ? t("plans.anchor.dryRuns") : t("plans.anchor.plans"), to: `${base}${listSearch}` }, { label: slug, mono: true }];
  const tabs: Array<{ value: Tab; label: ReactNode }> = [
    { value: "checklist", label: <><ListChecks size={13} /> {t("plans.overlay.tabs.checklist")}</> },
    { value: "graph", label: <><Network size={13} /> {t("plans.overlay.tabs.graph")}</> },
    { value: "source", label: <><FileCode2 size={13} /> {t("plans.overlay.tabs.source")}</> },
    { value: "history", label: <><History size={13} /> {t("plans.overlay.tabs.history")}</> },
  ];
  const theme = useResolvedTheme();
  const editorFontSize = usePreference("editorFontSize");
  const currentEnvironment = useCurrentEnvironment().name;
  const decorations = useMemo(() => (compiled && data ? hydrate(compiled, data, t) : []), [compiled, data, t]);
  const ordered = useMemo(() => (data ? { ...data, checks: orderedChecks(data.checks, compiled) } : undefined), [data, compiled]);
  const actionable = ordered?.checks.filter((check) => check.actionable) ?? [];
  const remove = useRemovePlan();
  const reset = useResetPlan();
  // Live Plans: the only action the interface takes on the agent's Plan is closing its open Session.
  const close = useClosePlan();
  const actionError = mutationError(reset.error ?? remove.error ?? close.error);
  const [confirming, setConfirming] = useState<"reset" | "delete" | "close">();

  return (
    <ResourceOverlay
      onClose={onClose}
      crumbs={crumbs}
      labelledBy="plan-title"
      kicker={t("plans.overlay.kicker")}
      badges={data ? <><ModeBadge mode={data.mode} /><PlanStateBadges workState={data.workState} sessionState={data.sessionState} />{currentEnvironment && data.environment !== currentEnvironment ? <span title={t("plans.overlay.otherEnvironmentHint", { environment: data.environment, current: currentEnvironment })}><Badge tone="warning" className="inline-flex items-center gap-1"><Server size={11} /> {t("plans.overlay.otherEnvironment", { environment: data.environment })}</Badge></span> : null}</> : null}
      id={expert && data ? `${data.procedure}@${data.procedureVersion} · ${data.environment}` : ""}
      title={slug}
      loading={plan.isLoading ? <LoadingState /> : notFound ? (
        <div className="p-8"><EmptyState title={t("plans.overlay.unknown", { slug })} body={plan.error?.message} action={<Button onClick={onClose}>{t("plans.overlay.backToPlans")}</Button>} /></div>
      ) : undefined}
      actions={
        <>
          {dryRun ? (
            <>
              <Button size="sm" icon={<RotateCcw size={13} />} disabled={reset.isPending || remove.isPending} title={t("plans.overlay.resetTitle")} onClick={() => setConfirming("reset")}>{t("plans.overlay.reset")}</Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={13} />} disabled={reset.isPending || remove.isPending} title={t("plans.overlay.deleteTitle")} onClick={() => setConfirming("delete")}>{t("common.actions.delete")}</Button>
            </>
          ) : data?.sessionState === "OPEN" ? (
            <Button size="sm" icon={<LockKeyhole size={13} />} disabled={close.isPending} title={t("plans.overlay.closeSessionTitle")} onClick={() => setConfirming("close")}>{t("plans.overlay.closeSession")}</Button>
          ) : null}
          <Button size="sm" icon={<Workflow size={13} />} onClick={() => data && navigate(`/procedures/${encodeURIComponent(data.procedure)}`, { state: origin })}>{t("plans.overlay.procedure")}</Button>
        </>
      }
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      tabActions={dryRun ? (
        <Button size="sm" variant={cockpitOpen ? "secondary" : "primary"} icon={<FlaskConical size={13} />} onClick={() => setCockpitOpen(!cockpitOpen)} title={cockpitOpen ? t("plans.overlay.hideCockpit") : t("plans.overlay.showCockpit")}>
          {t("plans.overlay.cockpit")}
        </Button>
      ) : undefined}
      tabMeta={expert && data
        ? data.missingDeclarations.length
          ? t("plans.overlay.tabMetaMissing", { checks: plural(data.checks.length, "check"), satisfied: data.satisfiedChecks, actionable: actionable.length, missing: plural(data.missingDeclarations.length, "missingDeclaration") })
          : t("plans.overlay.tabMeta", { checks: plural(data.checks.length, "check"), satisfied: data.satisfiedChecks, actionable: actionable.length })
        : undefined}
      // No inspector on Plans / dry-runs: the checklist, the summary strip and the cockpit carry everything.
    >
      <ConfirmDialog
        open={confirming !== undefined}
        tone={confirming === "delete" ? "danger" : "primary"}
        title={confirming === "delete" ? t("plans.overlay.confirm.deleteTitle", { slug }) : confirming === "close" ? t("plans.overlay.confirm.closeTitle", { slug }) : t("plans.overlay.confirm.resetTitle", { slug })}
        body={confirming === "delete"
          ? t("plans.overlay.confirm.deleteBody")
          : confirming === "close"
            ? t("plans.overlay.confirm.closeBody")
            : t("plans.overlay.confirm.resetBody")}
        confirmLabel={confirming === "delete" ? t("common.actions.delete") : confirming === "close" ? t("plans.overlay.closeSession") : t("plans.overlay.reset")}
        busy={reset.isPending || remove.isPending || close.isPending}
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => {
          const action = confirming; setConfirming(undefined);
          if (action === "close") close.mutate(data!.plan);
          else if (action === "reset") reset.mutate(data!.plan);
          else remove.mutate(data!.plan, { onSuccess: onClose });
        }}
      />
      {actionError ? <div className="border-b border-border p-2"><ErrorBox message={actionError} details={mutationErrorDetails(reset.error ?? remove.error ?? close.error)} /></div> : null}
      {ordered ? (
        <div className="flex h-full min-h-0">
        <div className="min-h-0 min-w-0 flex-1">
          {tab === "checklist" ? (
            <div className="flex h-full min-h-0 flex-col">
              <PlanSummaryStrip plan={ordered} compiled={compiled} onSelectCheck={(uri) => setSel(`check:${uri}`)} />
              <div className="min-h-0 flex-1"><PlanChecks plan={ordered} compiled={compiled} selected={sel} onSelect={setSel} /></div>
            </div>
          ) : null}
          {tab === "graph" ? (
            compiled ? <div className="h-full"><ProcedureGraph procedure={compiled} checks={ordered.checks} selected={sel} onSelect={setSel} /></div>
              : <div className="p-6"><EmptyState icon={<Network />} title={t("plans.overlay.notPublished")} body={t("plans.overlay.graphNeedsProcedure")} /></div>
          ) : null}
          {tab === "source" ? (
            compiled ? <GherkinEditor kind="procedure" value={compiled.source} onChange={() => undefined} readOnly theme={theme} fontSize={editorFontSize} decorations={decorations} />
              : <div className="p-6"><EmptyState icon={<FileCode2 />} title={t("plans.overlay.notPublished")} body={t("plans.overlay.sourceNeedsProcedure")} /></div>
          ) : null}
          {tab === "history" ? <PlanHistory plan={ordered} /> : null}
        </div>
        {dryRun && cockpitOpen ? (
          <aside className="relative shrink-0 border-l border-border bg-surface" style={{ width: cockpitWidth }} data-doc="cockpit">
            <ResizeHandle width={cockpitWidth} onResize={(width) => updatePreferences({ cockpitWidth: width })} />
            <PlanCockpit plan={ordered} compiled={compiled} onChanged={invalidate} runtime={runtime} selected={sel} onSelect={setSel} onClose={() => setCockpitOpen(false)} />
          </aside>
        ) : null}
        </div>
      ) : null}
    </ResourceOverlay>
  );
}

/** Compact reading of the plan above its checklist: progress, latest verdict, what is next. */
function PlanSummaryStrip({ plan, compiled, onSelectCheck }: { plan: PlanView; compiled: CompiledProcedure | undefined; onSelectCheck: (uri: string) => void }) {
  const { t } = useTranslation();
  const expert = useExpert();
  // The Procedure description takes room the checklist needs: folded by default, one click away.
  const [showDescription, setShowDescription] = useState(false);
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-4 py-3" data-doc="plan.summary">
      <section>
        <div className="flex flex-wrap items-center gap-3">
          <ProgressBar satisfied={plan.satisfiedChecks} total={plan.checks.length} />
          <span className="text-body text-muted">{expert ? t("plans.summary.revisionEngaged", { revision: plan.revision, when: relativeTime(plan.createdAt) }) : t("plans.summary.engaged", { when: relativeTime(plan.createdAt) })}</span>
        </div>
        <p className="mt-2 text-ui font-medium leading-relaxed">{compiled?.title ?? plan.procedure}</p>
        {compiled?.description ? (
          <div className="mt-1.5">
            <button type="button" aria-expanded={showDescription} onClick={() => setShowDescription((open) => !open)} className="-ml-1 inline-flex h-7 items-center gap-1 rounded-(--radius-1) px-1 text-body-lg font-medium text-muted hover:bg-surface-2 hover:text-text">
              <ChevronRight size={14} className={cx("shrink-0 transition-transform", showDescription && "rotate-90")} />
              {t("plans.summary.description")}
            </button>
            {showDescription ? <Description text={compiled.description} className="mt-1 max-w-4xl rounded-(--radius-2) border border-border bg-surface-2 px-3 py-2 text-body-lg leading-relaxed text-text" /> : null}
          </div>
        ) : null}
        {plan.latestQualification?.verdict === "NOT_VALIDATED" && plan.workState !== "COMPLETE" ? (
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-body-lg">
            <span className="kicker mr-2">{t("plans.summary.latestVerdict")}</span>
            <XCircle size={16} className="text-danger" />
            <button type="button" className="mono text-accent hover:underline" onClick={() => onSelectCheck(plan.latestQualification!.checkUri)}>{checkName(plan, plan.latestQualification.checkUri)}</button>
            <span className="text-muted"> — {plan.latestQualification.reason}</span>
          </p>
        ) : null}
      </section>
    </div>
  );
}

function PlanChecks({ plan, compiled, selected, onSelect }: { plan: PlanView; compiled: CompiledProcedure | undefined; selected: string | undefined; onSelect: (id: string | undefined) => void }) {
  const { t } = useTranslation();
  const selectedUri = selected?.startsWith("check:") ? selected.slice("check:".length) : undefined;
  // Two readings of the same Procedure order: beginning first, or latest Scenario first.
  const order = usePreference("planChecklistOrder");
  const grouped = groupScenarios(plan.checks, compiled);
  const scenarios = order === "reverse" ? [...grouped].reverse() : grouped;
  const toggleOrder = () => updatePreferences({ planChecklistOrder: (order === "forward" ? "reverse" : "forward") satisfies ChecklistOrder });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1">
        <span className="kicker">{t("plans.checklist.title")}</span>
        <span className="text-caption text-faint">{t("plans.checklist.satisfiedRatio", { satisfied: plan.satisfiedChecks, total: plan.checks.length })}</span>
        <IconButton size="sm" className="ml-auto" label={t(`plans.checklist.order.${order}`)} onClick={toggleOrder}>
          {order === "forward" ? <ArrowDown size={15} /> : <ArrowUp size={15} />}
        </IconButton>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-doc="plan.checklist">
        {scenarios.map((scenario) => (
          <li key={scenario.slug} className={cx("relative border-b border-border pl-7", scenario.satisfied === scenario.total && "text-muted")}>
            <span className="absolute inset-y-0 left-3 w-px bg-border" aria-hidden />
            {scenario.actionable ? (
              <span className="absolute left-[5px] top-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-contrast shadow-sm" aria-label={t("plans.checklist.current")} title={t("plans.checklist.current")}>
                <ChevronRight size={12} strokeWidth={3} />
              </span>
            ) : null}
            <div className={cx("flex items-center gap-2 bg-surface-2 px-3 py-2", scenario.actionable && "bg-accent-soft/60 ring-1 ring-inset ring-accent/20")}>
              <ScenarioStateIcon scenario={scenario} />
              <span className="min-w-0 flex-1 truncate text-body-lg font-medium text-text" title={scenario.title}>{scenario.title}</span>
              <Expert><span className="mono shrink-0 text-caption text-faint">{scenario.slug}</span></Expert>
              <span className="shrink-0 text-caption text-faint">{t("plans.checklist.satisfiedRatio", { satisfied: scenario.satisfied, total: scenario.total })}</span>
            </div>
            {scenario.groups.map((group) => (
              <div key={group.key} className={cx("border-t border-border first:border-t-0", scenario.satisfied === scenario.total && "opacity-65")}>
                {group.checks.length > 1 ? (
                  <div className="flex items-baseline gap-2 bg-bg px-3 py-1.5 text-label">
                    <span className="mono font-medium">{group.checks[0]!.name}</span>
                    <span className="text-muted">{t("plans.checklist.timesOnEach", { count: group.checks.length })} <span className="mono text-text">{group.checks[0]!.target.role}</span></span>
                    <span className="ml-auto text-faint">{t("plans.checklist.satisfiedRatio", { satisfied: group.checks.filter((check) => check.state === "SATISFIED").length, total: group.checks.length })}</span>
                  </div>
                ) : null}
                {group.checks.map((entry) => (
                  <div key={entry.checkUri} className={group.checks.length > 1 ? "border-t border-border pl-4" : ""}>
                    <CheckLine check={entry} selected={entry.checkUri === selectedUri} onClick={() => onSelect(entry.checkUri === selectedUri ? undefined : `check:${entry.checkUri}`)} />
                    {entry.checkUri === selectedUri ? (
                      <div className="border-t border-border bg-bg px-10 py-3" role="region" aria-label={t("plans.checklist.checkDetails", { check: entry.name })}>
                        <CheckDetail checkUri={entry.checkUri} />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScenarioStateIcon({ scenario }: { scenario: { satisfied: number; total: number; actionable: boolean; rejected: boolean } }) {
  const { t } = useTranslation();
  const state = scenario.satisfied === scenario.total ? "satisfied" : scenario.rejected ? "notValidated" : scenario.actionable ? "next" : "waiting";
  const label = t(`plans.checkLine.${state}`);
  return (
    <span className="flex w-4 shrink-0 justify-center" aria-label={label} title={label}>
      {state === "satisfied" ? <CheckCircle2 size={15} className="text-success" /> : state === "notValidated" ? <XCircle size={15} className="text-danger" /> : state === "next" ? <Play size={14} className="fill-current text-accent" /> : <Pause size={14} className="fill-current text-muted" />}
    </span>
  );
}

export function CheckLine({ check, selected, compact = false, onClick }: { check: PlanCheck; selected?: boolean; compact?: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onClick} aria-expanded={compact ? undefined : Boolean(selected)} className={`flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-surface-2 ${selected ? "bg-accent-soft" : ""}`}>
      <span className="min-w-0 flex-1">
        <span className="mono text-body-lg font-medium">{check.name}</span>
        <span className="block truncate text-label text-muted">{t("plans.checkLine.on")} <span className="mono text-text">{check.target.role}</span> = <span className="mono">{JSON.stringify(check.target.value)}</span></span>
      </span>
      {compact ? null : <ChevronRight size={15} className={cx("mt-0.5 shrink-0 text-faint transition-transform", selected && "rotate-90")} />}
    </button>
  );
}

function CheckDetail({ checkUri }: { checkUri: string }) {
  const { t } = useTranslation();
  const check = useCheck(checkUri);
  if (!check.data) return <LoadingState label={t("plans.checkDetail.reading")} />;
  const view = check.data;
  return (
    <div className="flex flex-col gap-4 text-body">
      <Expert><span className="mono block break-all text-meta text-faint">{view.checkUri}</span></Expert>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="kicker">{t("plans.checkDetail.operation")}</dt><dd className="mono truncate text-accent">{view.operation}</dd>
        <dt className="kicker">{t("plans.checkDetail.target")}</dt><dd className="mono text-muted">{view.target.role} = {JSON.stringify(view.target.value)}</dd>
      </dl>
      <section>
        <span className="kicker">{t("plans.checkDetail.inputs")}</span>
        <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-(--radius-2) border border-border bg-surface px-3 py-2">
          {Object.entries(view.inputs).map(([key, value]) => <div key={key} className="contents"><dt className="mono">{key}</dt><dd className="mono break-all text-muted">{JSON.stringify(value)}</dd></div>)}
        </dl>
      </section>
      <section>
        <span className="kicker">{t("plans.checkDetail.history")}</span>
        {view.history.length === 0 ? <p className="mt-1 text-muted">{t("plans.checkDetail.noVerdict")}</p> : null}
        <ul className="mt-1 flex flex-col gap-1">{[...view.history].reverse().map((entry) => (
          <li key={entry.snapshotId} className="rounded-(--radius-2) border border-border bg-surface px-3 py-2">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge state={entry.verdict} /><span>{entry.reason}</span><span className="ml-auto text-caption text-faint">{relativeTime(entry.calculatedAt)}</span></div>
            <Expert><span className="mono mt-1 block text-caption text-faint">{entry.reasonCode} · {plural(entry.factIds.length, "fact")}</span></Expert>
          </li>
        ))}</ul>
      </section>
      <section>
        <span className="kicker">{t("plans.checkDetail.attempts")}</span>
        {view.attempts.length === 0 ? <p className="mt-1 text-muted">{t("plans.checkDetail.noAttempt")}</p> : null}
        <ul className="mt-1 flex flex-col gap-2">{[...view.attempts].reverse().map((attempt) => (
          <li key={attempt.handle} className="rounded-(--radius-2) border border-border bg-surface px-3 py-2">
            <div className="flex flex-wrap items-center gap-2"><span className="mono font-medium">{attempt.attemptKey}</span><Badge>{attempt.state}</Badge><span className="ml-auto text-caption text-faint">{t("plans.checkDetail.admitted", { when: relativeTime(attempt.admittedAt) })}</span></div>
            {attempt.facts.length ? <div className="mt-2"><span className="kicker">{t("plans.checkDetail.facts")}</span><ul className="mt-1 flex flex-col gap-1">{attempt.facts.map((fact) => <li key={fact.id}><pre className="overflow-x-auto rounded-(--radius-1) bg-bg px-2 py-1 text-caption">{JSON.stringify(fact.values ?? {}, null, 2)}</pre></li>)}</ul></div> : null}
          </li>
        ))}</ul>
      </section>
    </div>
  );
}

function PlanHistory({ plan }: { plan: PlanView }) {
  const { t } = useTranslation();
  const expert = useExpert();
  const change = plan.latestRevisionChange;
  const parts: ReactNode[] = [
    expert ? <span key="rev">{t("plans.history.revChange", { from: String(change.fromRevision ?? "—"), to: change.toRevision })}</span> : null,
    change.added.length ? <span key="added" className="text-muted">{t("plans.history.added", { count: change.added.length })}</span> : null,
    change.removed.length ? <span key="removed" className="text-muted">{t("plans.history.removed", { count: change.removed.length })}</span> : null,
    change.newlySatisfied.length ? <span key="satisfied" className="text-success">{t("plans.history.satisfied", { count: change.newlySatisfied.length })}</span> : null,
    change.newlyOpened.length ? <span key="reopened" className="text-graph-data">{t("plans.history.reopened", { count: change.newlyOpened.length })}</span> : null,
  ].filter(Boolean);
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-bg p-4 [&>*]:shrink-0">
      <section className="rounded-(--radius-3) border border-border bg-surface p-4">
        <span className="kicker">{t("plans.history.latestChange")}</span>
        <p className="mt-1 text-body-lg">{parts.length ? parts.map((part, index) => <span key={index}>{index ? " · " : ""}{part}</span>) : <span className="text-faint">—</span>}</p>
      </section>
      <section className="rounded-(--radius-3) border border-border bg-surface">
        <div className="border-b border-border px-4 py-2 last:border-b-0"><span className="kicker">{t("plans.history.revisions")}</span> <span className="text-caption text-faint">{plan.revisions.length}</span></div>
        <Expert>
          <ul>
            {[...plan.revisions].reverse().map((revision) => (
              <li key={revision.revision} className="flex items-baseline gap-3 border-b border-border px-4 py-1.5 text-body last:border-b-0">
                <span className="w-12 shrink-0 font-medium">{t("plans.history.rev", { revision: revision.revision })}</span>
                <span className="text-muted">{plural(revision.checkUris.length, "check")}</span>
                <span className="mono truncate text-caption text-faint">{revision.definitionDigest.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        </Expert>
      </section>
    </div>
  );
}

/** The procedure source, hydrated with the Plan: role values on Background lines, live state on Scenario and Check lines. */
function hydrate(compiled: CompiledProcedure, plan: PlanView, t: TFunction): EditorDecoration[] {
  const decorations: EditorDecoration[] = [];
  const byTitle = new Map(compiled.scenarios.map((scenario) => [scenario.title, scenario.slug]));
  const roles = new Map(compiled.roles.map((role) => [role.name, role]));
  const checkNames = new Set(compiled.checks.map((check) => check.name));
  const stateOf = (checks: PlanCheck[]) => {
    if (checks.length === 0) return undefined;
    if (checks.every((check) => check.state === "SATISFIED")) return "satisfied" as const;
    if (checks.some((check) => check.latestVerdict === "NOT_VALIDATED" && check.state === "OPEN")) return "failed" as const;
    if (checks.some((check) => check.actionable)) return "actionable" as const;
    return "open" as const;
  };
  const summarize = (checks: PlanCheck[]) => {
    const satisfied = checks.filter((check) => check.state === "SATISFIED").length;
    const failed = checks.filter((check) => check.latestVerdict === "NOT_VALIDATED" && check.state === "OPEN");
    const actionable = checks.filter((check) => check.actionable).length;
    if (checks.length === 1) {
      const [check] = checks;
      if (check!.state === "SATISFIED") return t("plans.hydrate.satisfied", { reason: check!.reason ?? "" }).trim();
      if (check!.latestVerdict === "NOT_VALIDATED") return t("plans.hydrate.notValidated", { reason: check!.reason ?? "" }).trim();
      return check!.actionable ? t("plans.hydrate.actionable") : t("plans.hydrate.waitsFor", { checks: plural(check!.blockedBy.length, "check") });
    }
    const targets = checks.map((check) => String(check.target.value)).join(", ");
    return `${t("plans.hydrate.expansion", { count: checks.length, targets, satisfied })}${failed.length ? t("plans.hydrate.expansionNotValidated", { count: failed.length }) : ""}${actionable ? t("plans.hydrate.expansionActionable", { count: actionable }) : ""}`;
  };
  const document = parseGherkin(compiled.source);
  for (const child of document.feature?.children ?? []) {
    if (child.scenario) {
      const slug = byTitle.get(child.scenario.name);
      const checks = plan.checks.filter((check) => check.scenario === slug);
      const tone = stateOf(checks);
      if (tone) decorations.push({ line: child.scenario.location.line, tone, text: checks.length ? t("plans.hydrate.satisfiedRatio", { satisfied: checks.filter((check) => check.state === "SATISFIED").length, total: checks.length }) : undefined });
      else if (slug) decorations.push({ line: child.scenario.location.line, tone: "open", text: t("plans.hydrate.noCheckYet") });
      for (const step of child.scenario.steps) {
        const name = firstQuoted(step.text);
        if (!name || !checkNames.has(name)) continue;
        const instances = plan.checks.filter((entry) => entry.name === name);
        const checkTone = stateOf(instances);
        if (checkTone) decorations.push({ line: step.location.line, tone: checkTone, text: summarize(instances) });
      }
    }
    if (child.background) for (const step of child.background.steps) {
      const name = firstQuoted(step.text);
      const role = name ? roles.get(name) : undefined;
      if (!name || !role) continue;
      const value = plan.rootInputs[name] ?? plan.declarations[name];
      if (value !== undefined) decorations.push({ line: step.location.line, tone: "info", text: t("plans.hydrate.value", { value: describeValue(value) }) });
      else if (plan.missingDeclarations.includes(name)) decorations.push({ line: step.location.line, tone: "open", text: t("plans.hydrate.notDeclared") });
      else if (role.source.kind === "agent-declaration") decorations.push({ line: step.location.line, tone: "open", text: t("plans.hydrate.waitsForParent") });
    }
  }
  return decorations;
}

function firstQuoted(source: string): string | undefined {
  return tokenizeSentence(source).find((token) => token.kind === "quoted")?.value;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => (entry !== null && typeof entry === "object" && "value" in (entry as object) ? String((entry as { value: unknown }).value) : String(entry))).join(", ");
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

/** Left-edge grip: drag to resize the cockpit (persisted), double-click to reset. */
function ResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={t("plans.resize.title")}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/30 active:bg-accent/40"
      onDoubleClick={() => onResize(400)}
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const start = width;
        const move = (next: PointerEvent) => onResize(Math.min(720, Math.max(300, start + (startX - next.clientX))));
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

/** Consecutive instances of one Check (an "each" expansion) form a group; single Checks are groups of one. */
function groupExpanded(checks: readonly PlanCheck[]): Array<{ key: string; checks: PlanCheck[] }> {
  const groups: Array<{ key: string; checks: PlanCheck[] }> = [];
  for (const check of checks) {
    const last = groups[groups.length - 1];
    if (last && last.checks[0]!.name === check.name && last.checks[0]!.scenario === check.scenario) last.checks.push(check);
    else groups.push({ key: `${check.scenario}:${check.name}`, checks: [check] });
  }
  return groups;
}

function groupScenarios(checks: readonly PlanCheck[], compiled: CompiledProcedure | undefined): Array<{ slug: string; title: string; groups: Array<{ key: string; checks: PlanCheck[] }>; satisfied: number; total: number; actionable: boolean; rejected: boolean }> {
  const titles = new Map(compiled?.scenarios.map((scenario) => [scenario.slug, scenario.title]) ?? []);
  const scenarios: Array<{ slug: string; title: string; checks: PlanCheck[] }> = [];
  for (const check of checks) {
    const last = scenarios[scenarios.length - 1];
    if (last?.slug === check.scenario) last.checks.push(check);
    else scenarios.push({ slug: check.scenario, title: titles.get(check.scenario) ?? check.scenario, checks: [check] });
  }
  return scenarios.map((scenario) => ({
    slug: scenario.slug,
    title: scenario.title,
    groups: groupExpanded(scenario.checks),
    satisfied: scenario.checks.filter((check) => check.state === "SATISFIED").length,
    total: scenario.checks.length,
    actionable: scenario.checks.some((check) => check.actionable),
    rejected: scenario.checks.some((check) => check.state === "OPEN" && check.latestVerdict === "NOT_VALIDATED"),
  }));
}

function checkName(plan: PlanView, uri: string): string {
  return plan.checks.find((check) => check.checkUri === uri)?.name ?? uri;
}
