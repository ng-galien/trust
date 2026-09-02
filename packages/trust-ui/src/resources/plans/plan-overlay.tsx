import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleArrowUp, FileCode2, FlaskConical, History, ListChecks, LockKeyhole, Network, Play, RotateCcw, Server, Trash2, Workflow, XCircle } from "lucide-react";
import type { TFunction } from "i18next";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router";

import { cx, plural, relativeTime } from "../../lib/format.js";
import { useCurrentEnvironment } from "../../lib/environment.js";
import { mutationError, mutationErrorDetails, useClosePlan, useRemovePlan, useResetPlan, useResumePlan } from "../../lib/mutations.js";
import { usePlan, useProcedures, useRuntime } from "../../lib/runtime-context.js";
import type { CompiledProcedure, PlanCheck, PlanMode, PlanView } from "../../types.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { type EditorDecoration, GherkinEditor } from "../../gherkin-editor.js";
import { updatePreferences, useExpert, usePreference, useResolvedTheme } from "../../lib/preferences.js";
import { ConfirmDialog } from "../../ui/confirm.js";
import { Description } from "../../ui/description.js";
import { Expert } from "../../ui/expert.js";
import { Markdown } from "../../ui/markdown.js";
import { EmptyState, ErrorBox, LoadingState } from "../../ui/states.js";
import { useCloseTo, useOrigin } from "../shared/origin.js";
import { stripEphemeral, useOverlayViewState } from "../shared/overlay-state.js";
import { ResourceOverlay } from "../shared/resource-overlay.js";
import { ProcedureGraph } from "../procedures/procedure-graph.js";
import { PlanChecklist } from "./plan-checklist.js";
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
  const resume = useResumePlan();
  const actionError = mutationError(reset.error ?? remove.error ?? close.error);
  const resumeActionError = mutationError(resume.error);
  const [confirming, setConfirming] = useState<"reset" | "delete" | "close">();
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeReason, setResumeReason] = useState("");

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
          {data?.workState === "ESCALATED" ? (
            <Button size="sm" variant="primary" icon={<Play size={13} />} disabled={resume.isPending} title={t("plans.overlay.resumeTitle")} onClick={() => { resume.reset(); setResumeOpen(true); }}>{t("plans.overlay.resume")}</Button>
          ) : null}
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
      <ConfirmDialog
        open={resumeOpen}
        title={t("plans.overlay.confirm.resumeTitle", { slug })}
        body={<>
          <label className="mt-3 block text-text">
            <span className="kicker">{t("plans.overlay.confirm.resumeReason")}</span>
            <textarea
              aria-label={t("plans.overlay.confirm.resumeReason")}
              value={resumeReason}
              maxLength={4_096}
              rows={5}
              placeholder={t("plans.overlay.confirm.resumePlaceholder")}
              className="mt-2 w-full resize-y rounded-(--radius-2) border border-border bg-bg px-3 py-2 text-body-lg leading-relaxed text-text outline-none placeholder:text-faint focus:border-accent"
              onChange={(event) => setResumeReason(event.target.value)}
            />
            <span className="mt-1 block text-caption text-muted">{t("plans.overlay.confirm.resumeHint")}</span>
          </label>
          {resumeActionError ? <div className="mt-3"><ErrorBox message={resumeActionError} details={mutationErrorDetails(resume.error)} /></div> : null}
        </>}
        confirmLabel={t("plans.overlay.resume")}
        busy={resume.isPending}
        confirmDisabled={!resumeReason.trim()}
        onCancel={() => { resume.reset(); setResumeOpen(false); setResumeReason(""); }}
        onConfirm={() => {
          if (!data?.activeEscalation || !resumeReason.trim()) return;
          resume.mutate({ plan: data.plan, escalationId: data.activeEscalation.escalationId, resumeReason: resumeReason.trim() }, {
            onSuccess: () => { setResumeOpen(false); setResumeReason(""); },
          });
        }}
      />
      {actionError ? <div className="border-b border-border p-2"><ErrorBox message={actionError} details={mutationErrorDetails(reset.error ?? remove.error ?? close.error)} /></div> : null}
      {ordered ? (
        <div className="flex h-full min-h-0">
        <div className="min-h-0 min-w-0 flex-1">
          {tab === "checklist" ? (
            <div className="flex h-full min-h-0 flex-col">
              <PlanSummaryStrip plan={ordered} compiled={compiled} onSelectCheck={(uri) => setSel(`check:${uri}`)} />
              <div className="min-h-0 flex-1"><PlanChecklist plan={ordered} compiled={compiled} selected={sel} onSelect={setSel} /></div>
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
        {plan.activeEscalation ? (
          <section data-doc="plan.escalation" className="mt-3 overflow-hidden rounded-(--radius-3) border border-warning/40 bg-warning-soft" aria-labelledby="active-escalation-title">
            <div className="flex items-center gap-2 border-b border-warning/25 px-4 py-3 text-warning">
              <CircleArrowUp size={18} className="shrink-0" />
              <h2 id="active-escalation-title" className="text-ui font-semibold">{t("plans.summary.escalated")}</h2>
            </div>
            <div className="grid min-w-0 gap-3 p-3 lg:grid-cols-2">
              <EscalationDeclaration title={t("plans.summary.blockingReason")} value={plan.activeEscalation.blockingReason} />
              <EscalationDeclaration title={t("plans.summary.forbiddenFurtherAction")} value={plan.activeEscalation.forbiddenFurtherAction} />
            </div>
          </section>
        ) : null}
      </section>
    </div>
  );
}

function EscalationDeclaration({ title, value }: { title: string; value: string }) {
  return (
    <section className="min-w-0 rounded-(--radius-2) border border-warning/20 bg-surface px-4 py-3 shadow-xs">
      <h3 className="kicker mb-2 text-warning">{title}</h3>
      <Markdown>{value}</Markdown>
    </section>
  );
}

function PlanHistory({ plan }: { plan: PlanView }) {
  const { t } = useTranslation();
  const expert = useExpert();
  const change = plan.latestRevisionChange;
  const activity = plan.escalations.flatMap((escalation) => [
    { type: "escalated" as const, at: escalation.escalatedAt, escalation },
    ...(escalation.resumedAt && escalation.resumeReason
      ? [{ type: "resumed" as const, at: escalation.resumedAt, escalation }]
      : []),
  ]).sort((left, right) => {
    const byTime = right.at.localeCompare(left.at);
    if (byTime !== 0) return byTime;
    return (right.type === "resumed" ? 1 : 0) - (left.type === "resumed" ? 1 : 0);
  });
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
      {activity.length ? (
        <section aria-labelledby="plan-escalation-history" className="rounded-(--radius-3) border border-border bg-surface">
          <div className="border-b border-border px-4 py-2"><h2 id="plan-escalation-history" className="kicker inline">{t("plans.history.activity")}</h2> <span className="text-caption text-faint">{activity.length}</span></div>
          <ol>
            {activity.map((event) => (
              <li key={`${event.escalation.escalationId}:${event.type}`} className="border-b border-border p-4 last:border-b-0">
                <div className="flex items-start gap-3">
                  <span className={cx("mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full", event.type === "escalated" ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent")}>
                    {event.type === "escalated" ? <CircleArrowUp size={15} /> : <Play size={14} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <div><span className="text-ui font-semibold">{t(`plans.history.${event.type}`)}</span> <span className="mono ml-2 text-caption text-muted">{t("plans.history.check", { check: checkName(plan, event.escalation.checkUri) })}</span></div>
                      <time className="text-caption text-muted" dateTime={event.at} title={event.at}>{relativeTime(event.at)}</time>
                    </div>
                    {event.type === "escalated" ? (
                      <div className="mt-3 grid gap-3 lg:grid-cols-2">
                        <HistoryReason title={t("plans.history.blockingReason")} value={event.escalation.blockingReason} />
                        <HistoryReason title={t("plans.history.forbiddenFurtherAction")} value={event.escalation.forbiddenFurtherAction} />
                      </div>
                    ) : (
                      <div className="mt-3"><HistoryReason title={t("plans.history.resumeReason")} value={event.escalation.resumeReason!} /></div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
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

function HistoryReason({ title, value }: { title: string; value: string }) {
  return (
    <section className="min-w-0 rounded-(--radius-2) border border-border bg-bg px-3 py-2">
      <h3 className="kicker mb-1.5">{title}</h3>
      <Markdown className="text-body-lg">{value}</Markdown>
    </section>
  );
}

/** The procedure source, hydrated with the Plan: role values on Background lines, live state on Scenario and Check lines.
    Lines come from the compiled model's locations — the UI never parses the source itself. */
function hydrate(compiled: CompiledProcedure, plan: PlanView, t: TFunction): EditorDecoration[] {
  const decorations: EditorDecoration[] = [];
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
  for (const scenario of compiled.scenarios) {
    if (!scenario.location) continue;
    const checks = plan.checks.filter((check) => check.scenario === scenario.slug);
    const tone = stateOf(checks);
    if (tone) decorations.push({ line: scenario.location.line, tone, text: checks.length ? t("plans.hydrate.satisfiedRatio", { satisfied: checks.filter((check) => check.state === "SATISFIED").length, total: checks.length }) : undefined });
    else decorations.push({ line: scenario.location.line, tone: "open", text: t("plans.hydrate.noCheckYet") });
  }
  for (const check of compiled.checks) {
    if (!check.location) continue;
    const instances = plan.checks.filter((entry) => entry.name === check.name);
    const checkTone = stateOf(instances);
    if (checkTone) decorations.push({ line: check.location.line, tone: checkTone, text: summarize(instances) });
  }
  for (const role of compiled.roles) {
    if (!role.location) continue;
    const value = plan.rootInputs[role.name] ?? plan.declarations[role.name];
    if (value !== undefined) decorations.push({ line: role.location.line, tone: "info", text: t("plans.hydrate.value", { value: describeValue(value) }) });
    else if (plan.missingDeclarations.includes(role.name)) decorations.push({ line: role.location.line, tone: "open", text: t("plans.hydrate.notDeclared") });
    else if (role.source.kind === "agent-declaration" && role.source.optional === true) decorations.push({ line: role.location.line, tone: "info", text: t("plans.hydrate.optionalNotDeclared") });
    else if (role.source.kind === "agent-declaration") decorations.push({ line: role.location.line, tone: "open", text: t("plans.hydrate.waitsForParent") });
  }
  return decorations;
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

function checkName(plan: PlanView, uri: string): string {
  return plan.checks.find((check) => check.checkUri === uri)?.name ?? uri;
}
