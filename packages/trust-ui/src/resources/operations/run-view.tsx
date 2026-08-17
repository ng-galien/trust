import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronRight, Copy, Loader2, Play, Square, X } from "lucide-react";
import type { TFunction } from "i18next";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { cx, formatTime, plural, relativeTime } from "../../lib/format.js";
import { useCurrentEnvironment } from "../../lib/environment.js";
import { mutationError } from "../../lib/mutations.js";
import { useRuntime } from "../../lib/runtime-context.js";
import type { CompiledOperation, JsonObject, TrialEvent, TrialSummary, TrialView } from "../../types.js";
import { StatusBadge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { blankObject, Disclosure, type FieldIssue, SchemaForm, schemaProperties } from "../../ui/schema.js";
import { Select } from "../../ui/select.js";
import { EmptyState, ErrorBox } from "../../ui/states.js";
import { type StepType, stepTypeLabel } from "./model.js";
import { StepTypeMark } from "./operations-home.js";
import { ProducedTable } from "./simulation-view.js";

/* Run for real: TRUST spawns the packaged runner against a declared environment and streams its
   diagnostics (steps, command/HTTP logs, produced values). Nothing here is a Fact or a Plan. */

export function RunView({ source, compiled, dirty }: { source: string; compiled: CompiledOperation | undefined; dirty: boolean }) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const scope = dirty || !compiled ? { source } : { operation: compiled.operation, version: compiled.version };
  const environments = useQuery({
    queryKey: ["environments", scope],
    queryFn: () => runtime.environments(scope),
    enabled: Boolean(compiled) || dirty,
  });
  const trials = useQuery({
    queryKey: ["trials", compiled?.operation],
    queryFn: () => runtime.trials(compiled?.operation),
    enabled: Boolean(compiled),
    refetchInterval: (query) => (query.state.data?.some((trial) => trial.status === "starting" || trial.status === "running") ? 1_500 : false),
  });
  const [environment, setEnvironment] = useState("");
  const [input, setInput] = useState<JsonObject>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [inputIssues, setInputIssues] = useState<FieldIssue[]>([]);
  const [attempted, setAttempted] = useState(false);
  const onValidity = useCallback((_valid: boolean, issues: FieldIssue[]) => setInputIssues(issues), []);

  // The runtime qualifies each environment against the operation (compatible / missing values).
  const needed = useMemo(() => (compiled ? schemaProperties(compiled.environment).map(({ name }) => name) : []), [compiled]);
  const candidates = useMemo(() => (environments.data ?? []).map((entry) => ({ ...entry, missing: entry.missing ?? [] })), [environments.data]);
  const compatible = candidates.filter((entry) => entry.compatible !== false && entry.missing.length === 0);
  // The current environment is the default; when it cannot run the operation, say so and offer the compatible ones.
  const current = useCurrentEnvironment().name;
  const currentCandidate = candidates.find((entry) => entry.name === current);
  const currentBlocked = currentCandidate !== undefined && currentCandidate.missing.length > 0;
  const currentCompatible = current !== null && compatible.some((entry) => entry.name === current);
  // Follow the current environment whenever it can run the operation; otherwise keep a compatible choice or none.
  useEffect(() => {
    if (currentCompatible) { setEnvironment(current); return; }
    if (compatible.some((entry) => entry.name === environment)) return;
    setEnvironment("");
  }, [current, currentCompatible]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (environment && !compatible.some((entry) => entry.name === environment) && environments.isSuccess) setEnvironment(currentCompatible ? current : "");
  }, [compatible, environment, environments.isSuccess, current, currentCompatible]);
  useEffect(() => {
    if (!compiled) return;
    setInput((current) => ({ ...blankObject(compiled.input), ...Object.fromEntries(Object.entries(current).filter(([key]) => schemaProperties(compiled.input).some(({ name }) => name === key))) }));
  }, [compiled]);

  const start = useMutation({
    mutationFn: () =>
      runtime.startTrial({
        ...(dirty || !compiled ? { source } : { operation: compiled.operation, version: compiled.version }),
        environment,
        input,
      }),
    onSuccess: (trial) => {
      setSelected(trial.id);
      void queryClient.invalidateQueries({ queryKey: ["trials", compiled?.operation] });
    },
  });
  const cancel = useMutation({
    mutationFn: (trial: string) => runtime.cancelTrial(trial),
    onSuccess: (trial) => {
      setSelected(trial.id);
      void queryClient.invalidateQueries({ queryKey: ["trials", compiled?.operation] });
    },
  });
  const actionError = mutationError(start.error ?? cancel.error);
  const activeId = selected ?? trials.data?.[0]?.id ?? null;
  const startedInCatalog = start.data ? trials.data?.some((trial) => trial.id === start.data.id) === true : false;
  const activeTrial = trials.data?.find((trial) => trial.status === "starting" || trial.status === "running")
    ?? (!startedInCatalog && start.data && (start.data.status === "starting" || start.data.status === "running") ? start.data : undefined);

  if (!compiled && !dirty) {
    return <div className="p-6"><EmptyState icon={<Play />} title={t("operations.run.emptyTitle")} body={t("operations.run.emptyBody")} /></div>;
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[320px_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col border-r border-border">
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto bg-bg p-3 [&>*]:shrink-0">
          <div className="flex flex-col gap-1.5">
            <label className="text-caption font-semibold uppercase tracking-[0.06em] text-muted">{t("operations.run.environment")}</label>
            <Select
              ariaLabel={t("operations.run.environment")}
              value={environment}
              onChange={setEnvironment}
              options={candidates.map((entry) => ({
                value: entry.name,
                label: entry.name,
                meta: entry.missing.length ? t("operations.run.missingValues", { names: entry.missing.join(", ") }) : Object.keys(entry.values).join(", "),
                disabled: entry.missing.length > 0,
              }))}
              placeholder={environments.isLoading ? t("common.actions.loading") : compatible.length ? t("operations.run.chooseEnvironment") : t("operations.run.noCompatibleEnvironment")}
            />
            {currentBlocked && current ? (
              <p className="text-label text-warning">
                <AlertTriangle size={12} className="mr-1 inline" />
                {t("operations.run.notOnCurrent", { current, names: currentCandidate!.missing.join(", ") })}{" "}
                <Link to={`/environments/${encodeURIComponent(current)}`} className="underline">{t("operations.run.openEnvironment")}</Link>
                {compatible.length ? <span className="block text-muted">{t("operations.run.pickCompatible")}</span> : null}
              </p>
            ) : null}
            {environments.isSuccess && compatible.length === 0 && !currentBlocked ? (
              <p className="text-label text-danger">
                <AlertTriangle size={12} className="mr-1 inline" />
                {t("operations.run.noEnvironmentDeclaresPrefix")} {needed.map((name) => <code key={name} className="mono">{name}</code>).reduce<ReactNode[]>((acc, node, index) => (index ? [...acc, ", ", node] : [node]), [])}{t("operations.run.noEnvironmentDeclaresSuffix")}
              </p>
            ) : null}
            {environment && environments.data ? (
              <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-label">
                {Object.entries(environments.data.find((entry) => entry.name === environment)?.values ?? {}).map(([key, value]) => (
                  <ValueRow key={key} name={key} value={value} />
                ))}
              </dl>
            ) : null}
          </div>
          <Disclosure title={t("operations.run.input")} meta={compiled ? t("operations.run.inputMeta", { count: schemaProperties(compiled.input).length }) : "—"}>
            {compiled ? (
              <SchemaForm idPrefix="run-input" schema={compiled.input} value={input} onChange={setInput} onValidity={onValidity} touchedAll={attempted} empty={t("operations.run.inputEmpty")} />
            ) : (
              <p className="text-body text-faint">{t("operations.run.fixSource")}</p>
            )}
          </Disclosure>
          {dirty ? <p className="text-label text-warning"><AlertTriangle size={12} className="mr-1 inline" />{t("operations.run.unsavedWarning")}</p> : null}
          {actionError ? <ErrorBox message={actionError} /> : null}
          <Button
            variant={activeTrial ? "danger" : "primary"}
            icon={activeTrial ? <Square size={13} fill="currentColor" /> : <Play size={14} />}
            onClick={() => {
              if (activeTrial) {
                cancel.mutate(activeTrial.id);
                return;
              }
              setAttempted(true);
              if (inputIssues.length === 0) {
                cancel.reset();
                start.mutate();
              }
            }}
            disabled={activeTrial ? cancel.isPending || cancel.isSuccess : start.isPending || !environment || compatible.length === 0 || inputIssues.length > 0}
            title={!activeTrial && inputIssues.length ? t("operations.run.inputIncomplete", { fields: inputIssues.map((issue) => issue.field).join(", ") }) : undefined}
          >
            {activeTrial
              ? cancel.isPending || cancel.isSuccess ? t("operations.run.stopping") : t("operations.run.stopRun")
              : start.isPending ? t("operations.run.starting") : compatible.length === 0 ? t("operations.run.noCompatibleEnvironment") : inputIssues.length ? t("operations.run.completeInput", { count: inputIssues.length }) : t("operations.run.runForReal")}
          </Button>
          <p className="text-caption leading-snug text-faint">
            {t("operations.run.runnerNote")}
          </p>
          <TrialHistory trials={trials.data ?? []} active={activeId} onSelect={setSelected} />
        </div>
      </section>
      <section className="flex min-h-0 flex-col">
        {activeId && compiled ? <TrialTimeline key={activeId} trialId={activeId} compiled={compiled} onSettled={() => void queryClient.invalidateQueries({ queryKey: ["trials", compiled.operation] })} /> : (
          <div className="p-6"><EmptyState icon={<Play />} title={t("operations.run.noRunTitle")} body={t("operations.run.noRunBody")} /></div>
        )}
      </section>
    </div>
  );
}

function ValueRow({ name, value }: { name: string; value: unknown }) {
  return (
    <>
      <dt className="mono text-muted">{name}</dt>
      <dd className="mono truncate-1" title={String(value)}>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
    </>
  );
}

function TrialHistory({ trials, active, onSelect }: { trials: TrialSummary[]; active: string | null; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <section className="mt-2">
      <h4 className="kicker mb-1.5">{t("operations.run.recentRuns")} <span className="text-faint normal-case tracking-normal">{trials.length}</span></h4>
      {trials.length === 0 ? <p className="text-body text-faint">{t("operations.run.noRunYet")}</p> : null}
      <ul className="flex flex-col gap-0.5">
        {trials.map((trial) => (
          <li key={trial.id}>
            <button
              type="button"
              onClick={() => onSelect(trial.id)}
              className={cx("flex w-full items-center gap-2 rounded-(--radius-1) px-2 py-1.5 text-left text-body hover:bg-surface-2", active === trial.id && "bg-surface-3")}
            >
              <StatusDot status={trial.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate-1">{trial.environment} · {relativeTime(trial.startedAt)}</span>
                <span className="block text-caption text-faint">{trial.status}{trial.endedAt ? ` · ${duration(trial.startedAt, trial.endedAt)}` : ""}</span>
              </span>
              <ChevronRight size={12} className="text-faint" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusDot({ status }: { status: string }) {
  const tone = status === "succeeded" ? "bg-success" : status === "failed" || status === "aborted" ? "bg-danger" : "bg-info animate-pulse";
  return <span className={cx("h-2 w-2 shrink-0 rounded-full", tone)} aria-label={status} />;
}

/* --------------------------------------------------------------- timeline */

function useTrial(trialId: string, onSettled: () => void) {
  const runtime = useRuntime();
  const [trial, setTrial] = useState<TrialView | null>(null);
  const [events, setEvents] = useState<TrialEvent[]>([]);
  const [connection, setConnection] = useState<"idle" | "live" | "closed" | "error">("idle");
  const settled = useRef(false);

  useEffect(() => {
    let source: EventSource | undefined;
    let cancelled = false;
    settled.current = false;
    setTrial(null);
    setEvents([]);
    void runtime.trial(trialId).then((view) => {
      if (cancelled) return;
      setTrial(view);
      setEvents(view.events);
      const terminal = view.status !== "starting" && view.status !== "running";
      if (terminal) {
        setConnection("closed");
        return;
      }
      const last = view.events.at(-1)?.sequence ?? 0;
      source = new EventSource(`${runtime.trialStreamUrl(trialId)}?after=${last}`);
      setConnection("live");
      source.onmessage = () => undefined;
      const onEvent = (raw: MessageEvent<string>) => {
        const event = JSON.parse(raw.data) as TrialEvent;
        setEvents((current) => (current.some((entry) => entry.sequence === event.sequence) ? current : [...current, event]));
        if (event.type === "trial.completed" && !settled.current) {
          settled.current = true;
          void runtime.trial(trialId).then((final) => { if (!cancelled) setTrial(final); onSettled(); });
        }
      };
      for (const type of ["trial.started", "runner.log", "operation.start", "step.start", "step.log", "step.end", "operation.end", "span", "trial.completed", "log"]) {
        source.addEventListener(type, onEvent as EventListener);
      }
      source.addEventListener("end", () => { source?.close(); setConnection("closed"); });
      source.onerror = () => { if (source?.readyState === EventSource.CLOSED) setConnection("closed"); else setConnection("error"); };
    }).catch(() => setConnection("error"));
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [runtime, trialId, onSettled]);

  return { trial, events, connection };
}

interface StepState {
  name: string;
  index: number;
  kind: StepType;
  summary: string;
  detail: JsonObject;
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
  durationMs?: number;
  outcome?: JsonObject;
  error?: string;
  /** Console output in arrival order; consecutive chunks of one stream are merged. */
  output: Array<{ stream: string; text: string }>;
}

function TrialTimeline({ trialId, compiled, onSettled }: { trialId: string; compiled: CompiledOperation; onSettled: () => void }) {
  const { t } = useTranslation();
  const stableSettled = useCallback(onSettled, [onSettled]);
  const { trial, events, connection } = useTrial(trialId, stableSettled);
  const [copied, setCopied] = useState(false);

  const steps = useMemo(() => {
    const map = new Map<string, StepState>();
    for (const event of events) {
      if (event.type === "step.start") {
        map.set(String(event.step), { name: String(event.step), index: Number(event.index ?? map.size), kind: event.kind as StepType, summary: String(event.summary ?? ""), detail: (event.detail as JsonObject) ?? {}, startedAt: event.at, output: [] });
      } else if (event.type === "step.log") {
        const step = map.get(String(event.step));
        if (step) {
          const stream = String(event.stream);
          const text = String(event.text ?? "");
          const last = step.output.at(-1);
          if (last && last.stream === stream) last.text += text;
          else step.output.push({ stream, text });
        }
      } else if (event.type === "step.end") {
        const step = map.get(String(event.step));
        if (step) Object.assign(step, { endedAt: event.at, ok: Boolean(event.ok), durationMs: Number(event.durationMs ?? 0), outcome: (event.outcome as JsonObject) ?? {}, ...(event.error ? { error: String(event.error) } : {}) });
      }
    }
    // Newest first: the step currently running sits at the top while a trial streams.
    return Array.from(map.values()).sort((a, b) => b.index - a.index);
  }, [events]);
  const stepCount = Number(events.find((event) => event.type === "operation.start")?.stepCount ?? steps.length);
  const runningStep = steps.find((step) => step.endedAt === undefined);
  const elapsed = useElapsed(trial?.startedAt, trial?.endedAt);
  const operationEnd = events.find((event) => event.type === "operation.end");
  const runnerLogs = events.filter((event) => event.type === "runner.log");
  const completed = events.find((event) => event.type === "trial.completed");
  const status = completed ? String(completed.status ?? trial?.status ?? "failed") : trial?.status === "starting" && events.length > 1 ? "running" : (trial?.status ?? "starting");
  const live = status === "starting" || status === "running";
  const produced = (operationEnd?.produced as JsonObject | undefined) ?? (trial?.outcome?.produced as JsonObject | undefined);
  const failure = trial?.error ?? (operationEnd && operationEnd.ok === false ? String(operationEnd.error ?? "") : undefined);

  const copyReport = async () => {
    if (!trial) return;
    await navigator.clipboard.writeText(buildReport(trial, steps, produced, failure, runnerLogs));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusBadge state={status} />
            {live ? <Loader2 size={13} className="animate-spin text-muted" /> : null}
            <span className="text-body-lg font-semibold">{trial ? `${trial.operation}@${trial.version}` : "…"}</span>
            <span className="text-label text-muted">{t("operations.run.on", { environment: trial?.environment ?? "…" })}</span>
          </div>
          <span className="block text-caption text-faint">
            {trial ? t("operations.run.startedBy", { time: formatTime(trial.startedAt), user: trial.startedBy }) : ""}{trial?.endedAt ? ` · ${duration(trial.startedAt, trial.endedAt)}` : ""}
            {connection === "live" ? t("operations.run.streaming") : connection === "error" ? t("operations.run.streamInterrupted") : ""}
          </span>
        </div>
        <Button size="sm" icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={() => void copyReport()} disabled={!trial}>
          {copied ? t("common.actions.copied") : t("operations.run.copyReport")}
        </Button>
      </div>
      {live ? (
        <div className="shrink-0 border-b border-border bg-surface px-4 py-2">
          <div className="flex items-center gap-3 text-body">
            <Loader2 size={13} className="animate-spin text-accent" />
            <span className="font-medium">
              {runningStep ? (stepCount ? t("operations.run.runningStepOf", { index: String(runningStep.index + 1), total: String(stepCount) }) : t("operations.run.runningStep", { index: String(runningStep.index + 1) })) : steps.length === 0 ? t("operations.run.startingRunner") : t("operations.run.finishing")}
            </span>
            {steps.filter((step) => step.endedAt !== undefined).length ? (
              <span className="text-muted">
                {t("operations.run.done", { count: steps.filter((step) => step.endedAt !== undefined).length })}
                {steps.some((step) => step.ok === false) ? <span className="text-danger">{t("operations.run.failed", { count: steps.filter((step) => step.ok === false).length })}</span> : null}
              </span>
            ) : null}
            {runningStep ? <span className="mono min-w-0 flex-1 truncate-1 text-muted">{runningStep.summary || runningStep.name}</span> : <span className="flex-1" />}
            <span className="tabular-nums text-muted">{elapsed}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${stepCount ? Math.min(100, ((steps.filter((step) => step.endedAt).length + (runningStep ? 0.5 : 0)) / stepCount) * 100) : 5}%` }} />
          </div>
        </div>
      ) : null}
      {live ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 bg-bg p-3">
          {runningStep ? (
            <FocusedStep step={runningStep} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-body text-faint">{steps.length === 0 ? t("operations.run.waitingRunner") : t("operations.run.computingProduced")}</div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto bg-bg p-3 [&>*]:shrink-0">
          {trial?.input && Object.keys(trial.input).length ? (
            <div className="text-body text-muted">
              {t("operations.run.inputLabel")} <span className="mono text-text">{Object.entries(trial.input).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join("  ")}</span>
            </div>
          ) : null}
          {failure ? <ErrorBox message={failure} /> : null}
          {produced ? (
            <section className="rounded-(--radius-2) border border-success/30 bg-surface p-3">
              <h4 className="kicker mb-2 text-success">{t("operations.run.producedValues")}</h4>
              <ProducedTable compiled={compiled} produced={produced} />
            </section>
          ) : null}
          {steps.map((step) => (
            <StepCard key={step.name} step={step} live={false} />
          ))}
          {runnerLogs.length ? (
            <details className="text-body">
              <summary className="cursor-pointer text-muted hover:text-text">{t("operations.run.runnerLog", { count: runnerLogs.length })}</summary>
              <pre className="mono mt-2 rounded-(--radius-2) border border-border bg-surface-2 p-3 text-label leading-relaxed">{runnerLogs.map((event) => `${event.at} [${String(event.level ?? "info")}] ${String(event.text ?? "")}`).join("\n")}</pre>
            </details>
          ) : null}
          <details className="text-body">
            <summary className="cursor-pointer text-muted hover:text-text">{t("operations.run.allEvents", { count: events.length })}</summary>
            <pre className="mono mt-2 max-h-96 overflow-auto rounded-(--radius-2) border border-border bg-surface-2 p-3 text-caption leading-relaxed">{JSON.stringify(events, null, 2)}</pre>
          </details>
        </div>
      )}
    </>
  );
}

/** The step being executed: fills the whole visualisation area, console follows the tail. */
function FocusedStep({ step }: { step: StepState }) {
  const { t } = useTranslation();
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-(--radius-2) border border-accent/50 bg-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="w-4 text-right text-caption text-faint">{step.index + 1}</span>
        <StepTypeMark type={step.kind} />
        <span className="mono min-w-0 flex-1 truncate-1 text-body-lg" title={step.summary}>{step.summary || step.name}</span>
        <Loader2 size={13} className="animate-spin text-accent" />
      </div>
      <dl className="grid shrink-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-border px-3 py-1.5 text-caption">
        {Object.entries(step.detail).map(([key, value]) => (
          <ValueRow key={key} name={key} value={value} />
        ))}
      </dl>
      <div className="flex min-h-0 flex-1 flex-col p-2">
        {step.output.length ? <Console output={step.output} live fill /> : <p className="p-2 text-label text-faint">{t("operations.run.waitingOutput")}</p>}
      </div>
    </section>
  );
}

function StepCard({ step, live }: { step: StepState; live: boolean }) {
  const { t } = useTranslation();
  const running = step.endedAt === undefined && live;
  const [open, setOpen] = useState(running || step.ok === false);
  const wasRunning = useRef(running);
  useEffect(() => {
    // Collapse a step once it finishes successfully so the running one stays in view; keep failures open.
    if (wasRunning.current && !running) setOpen(step.ok === false);
    wasRunning.current = running;
  }, [running, step.ok]);

  return (
    <section className={cx("rounded-(--radius-2) border bg-surface", step.ok === false ? "border-danger/40" : running ? "border-accent/50" : "border-border")}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2">
        <ChevronRight size={13} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <span className="w-4 text-right text-caption text-faint">{step.index + 1}</span>
        <StepTypeMark type={step.kind} />
        <span className="mono min-w-0 flex-1 truncate-1 text-body-lg" title={step.summary}>{step.summary || step.name}</span>
        {step.output.length ? <span className="text-meta text-faint">{outputSummary(step.output, t)}</span> : null}
        {running ? <Loader2 size={13} className="animate-spin text-accent" /> : step.ok === undefined ? <span className="text-caption text-faint">{t("operations.run.pending")}</span> : step.ok ? <Check size={14} className="text-success" /> : <X size={14} className="text-danger" />}
        {step.durationMs !== undefined ? <span className="w-14 text-right text-caption tabular-nums text-muted">{step.durationMs} ms</span> : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-label">
            <dt className="text-faint">{t("operations.run.step")}</dt><dd className="mono">{t("operations.run.stepKind", { name: step.name, kind: stepTypeLabel(step.kind) })}</dd>
            {Object.entries(step.detail).map(([key, value]) => (
              <ValueRow key={key} name={key} value={value} />
            ))}
            {step.outcome && Object.keys(step.outcome).length ? <><dt className="text-faint">{t("operations.run.outcome")}</dt><dd className="mono truncate-1">{Object.entries(step.outcome).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join("  ")}</dd></> : null}
          </dl>
          {step.error ? <ErrorBox message={step.error} /> : null}
          {step.output.length ? <Console output={step.output} live={running} /> : <p className="text-label text-faint">{running ? t("operations.run.waitingOutput") : t("operations.run.noOutput")}</p>}
        </div>
      ) : null}
    </section>
  );
}

/** Display label of an output stream; `stdout`/`stderr` and unknown streams keep their raw name. */
function streamLabel(stream: string, t: TFunction): string {
  switch (stream) {
    case "http.request": return t("operations.run.streams.httpRequest");
    case "http.response": return t("operations.run.streams.httpResponse");
    case "file": return t("operations.run.streams.file");
    case "runner": return t("operations.run.streams.runner");
    default: return stream;
  }
}

function outputSummary(output: Array<{ stream: string; text: string }>, t: TFunction): string {
  const totals = new Map<string, number>();
  for (const entry of output) totals.set(entry.stream, (totals.get(entry.stream) ?? 0) + countLines(entry.text));
  return Array.from(totals.entries()).map(([stream, lines]) => `${streamLabel(stream, t)} ${lines}`).join(" · ");
}

function countLines(text: string): number {
  if (text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

const streamClass: Record<string, string> = {
  stdout: "text-text",
  stderr: "text-warning",
  "http.request": "text-accent",
  "http.response": "text-text",
  file: "text-text",
  runner: "text-muted",
};

/** One console per step: every stream interleaved in arrival order, coloured per stream, following the tail while live. */
function Console({ output, live, fill = false }: { output: Array<{ stream: string; text: string }>; live: boolean; fill?: boolean }) {
  const { t } = useTranslation();
  const pre = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const plain = output.map((entry) => entry.text).join("");
  const streams = Array.from(new Set(output.map((entry) => entry.stream)));
  useEffect(() => {
    if (live && follow && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [plain, live, follow]);

  const copy = async () => {
    await navigator.clipboard.writeText(plain);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  return (
    <div className={cx(fill && "flex min-h-0 flex-1 flex-col")}>
      <div className="mb-1 flex shrink-0 items-center gap-2">
        {streams.map((stream) => (
          <span key={stream} className={cx("inline-flex items-center gap-1 text-meta", streamClass[stream] ?? "text-text")}>
            <span className={cx("h-1.5 w-1.5 rounded-full", stream === "stderr" ? "bg-warning" : stream === "http.request" ? "bg-accent" : "bg-muted")} />
            {streamLabel(stream, t)}
          </span>
        ))}
        <span className="text-meta text-faint">· {plural(countLines(plain), "line")}{live ? t("operations.run.streaming") : ""}</span>
        {live && !follow ? <button type="button" onClick={() => setFollow(true)} className="text-meta text-accent hover:underline">{t("operations.run.followOutput")}</button> : null}
        <button type="button" onClick={() => void copy()} className="ml-auto inline-flex items-center gap-1 text-meta text-muted hover:text-text">
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? t("common.actions.copied") : t("operations.run.copyOutput")}
        </button>
      </div>
      <pre
        ref={pre}
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
        }}
        className={cx("mono overflow-auto rounded-(--radius-2) border bg-surface-2 p-2.5 text-label leading-relaxed whitespace-pre-wrap break-words", fill ? "min-h-0 flex-1" : "max-h-[32rem]", live ? "border-accent/30" : "border-border")}
      >
        {output.map((entry, index) => (
          <span key={index} className={streamClass[entry.stream] ?? "text-text"} data-stream={entry.stream}>{entry.text}</span>
        ))}
        {plain === "" ? " " : null}
      </pre>
    </div>
  );
}

function useElapsed(startedAt?: string, endedAt?: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || endedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [startedAt, endedAt]);
  if (!startedAt) return "";
  const end = endedAt ? Date.parse(endedAt) : now;
  return duration(startedAt, new Date(end).toISOString());
}

function duration(start: string, end: string): string {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms)) return "";
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function buildReport(trial: TrialView, steps: StepState[], produced: JsonObject | undefined, failure: string | undefined, runnerLogs: TrialEvent[]): string {
  const lines: string[] = [];
  lines.push(`# TRUST trial report — ${trial.operation}@${trial.version}`);
  lines.push("");
  lines.push(`- Trial: ${trial.id}`);
  lines.push(`- Status: ${trial.status}`);
  lines.push(`- Environment: ${trial.environment}`);
  lines.push(`- Started: ${trial.startedAt} by ${trial.startedBy}${trial.endedAt ? ` · ended ${trial.endedAt} (${duration(trial.startedAt, trial.endedAt)})` : ""}`);
  lines.push(`- Input: ${JSON.stringify(trial.input)}`);
  lines.push("");
  for (const step of steps) {
    lines.push(`## Step ${step.index + 1} · ${step.name} (${step.kind}) — ${step.ok === undefined ? "pending" : step.ok ? "ok" : "failed"}${step.durationMs !== undefined ? ` · ${step.durationMs} ms` : ""}`);
    lines.push("");
    lines.push(`- ${step.summary}`);
    for (const [key, value] of Object.entries(step.detail)) lines.push(`- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    if (step.outcome) for (const [key, value] of Object.entries(step.outcome)) lines.push(`- outcome.${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    if (step.error) lines.push(`- error: ${step.error}`);
    if (step.output.length) {
      lines.push("");
      lines.push("### Output");
      lines.push("```");
      for (const entry of step.output) {
        const prefix = entry.stream === "stdout" ? "" : `[${entry.stream}] `;
        lines.push(entry.text.replace(/\n$/, "").split("\n").map((line) => `${prefix}${line}`).join("\n"));
      }
      lines.push("```");
    }
    lines.push("");
  }
  if (failure) {
    lines.push(`## Failure`);
    lines.push("");
    lines.push(failure);
    lines.push("");
  }
  if (produced) {
    lines.push("## Produced values");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(produced, null, 2));
    lines.push("```");
    lines.push("");
  }
  if (runnerLogs.length) {
    lines.push("## Runner log");
    lines.push("");
    for (const event of runnerLogs) lines.push(`- ${event.at} [${String(event.level ?? "info")}] ${String(event.text ?? "")}`);
  }
  return lines.join("\n");
}
