import { ArrowDown, ArrowUp, CheckCircle2, ChevronRight, Circle, Pause, Play, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cx, plural, relativeTime } from "../../lib/format.js";
import { type ChecklistOrder, updatePreferences, useExpert, usePreference } from "../../lib/preferences.js";
import { useCheck } from "../../lib/runtime-context.js";
import type { CompiledProcedure, PlanCheck, PlanView } from "../../types.js";
import { Badge, StatusBadge } from "../../ui/badge.js";
import { IconButton } from "../../ui/button.js";
import { Expert } from "../../ui/expert.js";
import { LoadingState } from "../../ui/states.js";
import { orderedScenarios } from "../procedures/model.js";

export interface PlanChecklistGroup {
  readonly key: string;
  readonly name: string;
  readonly role: string;
  readonly operation: string;
  readonly each: boolean;
  readonly checks: readonly PlanCheck[];
}

export interface PlanChecklistScenario {
  readonly slug: string;
  readonly title: string;
  readonly groups: readonly PlanChecklistGroup[];
  readonly satisfied: number;
  readonly total: number;
  readonly actionable: boolean;
  readonly rejected: boolean;
}

export function PlanChecklist({ plan, compiled, selected, onSelect }: { plan: PlanView; compiled: CompiledProcedure | undefined; selected: string | undefined; onSelect: (id: string | undefined) => void }) {
  const { t } = useTranslation();
  const selectedUri = selected?.startsWith("check:") ? selected.slice("check:".length) : undefined;
  const order = usePreference("planChecklistOrder");
  const grouped = buildPlanChecklist(plan.checks, compiled);
  const scenarios = order === "reverse" ? [...grouped].reverse() : grouped;
  const toggleOrder = () => updatePreferences({ planChecklistOrder: (order === "forward" ? "reverse" : "forward") satisfies ChecklistOrder });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5">
        <span className="kicker">{t("plans.checklist.title")}</span>
        <span className="text-caption text-faint">{t("plans.checklist.satisfiedRatio", { satisfied: plan.satisfiedChecks, total: plan.checks.length })}</span>
        <IconButton size="sm" className="ml-auto" label={t(`plans.checklist.order.${order}`)} onClick={toggleOrder}>
          {order === "forward" ? <ArrowDown size={15} /> : <ArrowUp size={15} />}
        </IconButton>
      </div>
      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto bg-bg px-4 py-3" data-doc="plan.checklist">
        {scenarios.map((scenario, index) => (
          <PlanScenarioBranch
            key={scenario.slug}
            scenario={scenario}
            position={order === "forward" ? index + 1 : scenarios.length - index}
            selectedUri={selectedUri}
            onSelect={onSelect}
          />
        ))}
      </ol>
    </div>
  );
}

export function PlanScenarioBranch({ scenario, position, selectedUri, onSelect }: { scenario: PlanChecklistScenario; position: number; selectedUri: string | undefined; onSelect: (id: string | undefined) => void }) {
  const { t } = useTranslation();
  const state = scenarioState(scenario);
  return (
    <li className={cx("relative pl-9 pb-3", state === "satisfied" && "text-muted")}>
      <span className="absolute bottom-0 left-[15px] top-8 w-px bg-border" aria-hidden />
      <span className={cx("absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full border bg-surface text-caption font-semibold", scenario.actionable ? "border-accent bg-accent-soft text-accent" : "border-border text-muted")}>
        {position}
      </span>
      <div className="flex min-h-8 items-center gap-2 border-b border-border pb-2">
        <ScenarioStateIcon state={state} />
        <span className="min-w-0 flex-1 text-body-lg font-semibold text-text" title={scenario.title}>{scenario.title}</span>
        <span className={cx("shrink-0 text-label font-medium", state === "satisfied" ? "text-success" : state === "notValidated" ? "text-danger" : state === "current" ? "text-accent" : "text-muted")}>{t(`plans.checklist.scenarioState.${state}`)}</span>
        <Expert><span className="mono shrink-0 text-caption text-faint">{scenario.slug}</span></Expert>
        {scenario.total > 0 ? <span className="shrink-0 text-caption text-faint">{t("plans.checklist.satisfiedRatio", { satisfied: scenario.satisfied, total: scenario.total })}</span> : null}
      </div>
      <ol className="mt-1">
        {scenario.groups.map((group) => (
          <PlanCheckBranch key={group.key} group={group} selectedUri={selectedUri} onSelect={onSelect} />
        ))}
      </ol>
    </li>
  );
}

export function PlanCheckBranch({ group, selectedUri, onSelect }: { group: PlanChecklistGroup; selectedUri: string | undefined; onSelect: (id: string | undefined) => void }) {
  const { t } = useTranslation();
  const satisfied = group.checks.filter((check) => check.state === "SATISFIED").length;
  if (!group.each) {
    const [check] = group.checks;
    return check ? <li><PlanCheckInstance check={check} selected={check.checkUri === selectedUri} onSelect={onSelect} /></li> : null;
  }
  return (
    <li className="relative py-2 pl-6">
      <span className="absolute bottom-3 left-[7px] top-4 w-px bg-border" aria-hidden />
      <span className="absolute left-[7px] top-4 h-px w-3 bg-border" aria-hidden />
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="mono text-body-lg font-semibold text-text">{group.name}</span>
        <Badge tone="neutral" className="mono">{t("plans.checklist.forEach", { role: group.role })}</Badge>
        <span className="text-label text-muted">{t("plans.checklist.instances", { count: group.checks.length })}</span>
        <span className="ml-auto text-caption text-faint">{group.checks.length > 0 ? t("plans.checklist.satisfiedRatio", { satisfied, total: group.checks.length }) : t("plans.checklist.noInstances")}</span>
      </div>
      {group.checks.length > 0 ? (
        <ol className="ml-3 mt-1 border-l border-border pl-3">
          {group.checks.map((check) => (
            <li key={check.checkUri} className="relative before:absolute before:-left-3 before:top-4 before:h-px before:w-3 before:bg-border">
              <PlanCheckInstance check={check} selected={check.checkUri === selectedUri} onSelect={onSelect} instance />
            </li>
          ))}
        </ol>
      ) : <p className="mono ml-3 mt-1 border-l border-border py-1 pl-3 text-label text-faint">{group.operation}</p>}
    </li>
  );
}

export function PlanCheckInstance({ check, selected = false, onSelect, instance = false }: { check: PlanCheck; selected?: boolean; onSelect: (id: string | undefined) => void; instance?: boolean }) {
  const { t } = useTranslation();
  const state = checkState(check);
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(selected ? undefined : `check:${check.checkUri}`)}
        aria-expanded={selected}
        className={cx("group flex w-full items-start gap-3 rounded-(--radius-2) px-3 py-2 text-left transition-colors hover:bg-surface-2", selected && "bg-accent-soft ring-1 ring-inset ring-accent/25")}
      >
        <CheckStateIcon state={state} />
        <span className="min-w-0 flex-1">
          <span className={cx("mono block text-body-lg font-medium text-text", instance && "break-all")}>{instance ? JSON.stringify(check.target.value) : check.name}</span>
          <span className="block truncate text-label text-muted">
            {instance ? <>{check.target.role} · <span className="mono">{check.operation}</span></> : <>{t("plans.checkLine.on")} <span className="mono text-text">{check.target.role}</span> = <span className="mono">{JSON.stringify(check.target.value)}</span></>}
          </span>
        </span>
        <span className={cx("mt-0.5 shrink-0 text-label font-medium", state === "satisfied" ? "text-success" : state === "notValidated" ? "text-danger" : state === "next" ? "text-accent" : "text-muted")}>{t(`plans.checkLine.${state}`)}</span>
        <ChevronRight size={15} className={cx("mt-0.5 shrink-0 text-faint transition-transform", selected && "rotate-90")} />
      </button>
      {selected ? (
        <div className="ml-7 border-l border-border bg-bg px-5 py-3" role="region" aria-label={t("plans.checklist.checkDetails", { check: check.name })}>
          <PlanCheckDetails checkUri={check.checkUri} />
        </div>
      ) : null}
    </>
  );
}

/** Compact Check selector shared with the dry-run cockpit. */
export function CheckLine({ check, selected, compact = false, onClick }: { check: PlanCheck; selected?: boolean; compact?: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onClick} aria-expanded={compact ? undefined : Boolean(selected)} className={cx("flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-surface-2", selected && "bg-accent-soft")}>
      <span className="min-w-0 flex-1">
        <span className="mono text-body-lg font-medium">{check.name}</span>
        <span className="block truncate text-label text-muted">{t("plans.checkLine.on")} <span className="mono text-text">{check.target.role}</span> = <span className="mono">{JSON.stringify(check.target.value)}</span></span>
      </span>
      {compact ? null : <ChevronRight size={15} className={cx("mt-0.5 shrink-0 text-faint transition-transform", selected && "rotate-90")} />}
    </button>
  );
}

export function PlanCheckDetails({ checkUri }: { checkUri: string }) {
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

export function buildPlanChecklist(checks: readonly PlanCheck[], compiled: CompiledProcedure | undefined): PlanChecklistScenario[] {
  const runtimeScenarios: Array<{ slug: string; title: string; checks: PlanCheck[] }> = [];
  const titles = new Map(compiled?.scenarios.map((scenario) => [scenario.slug, scenario.title]) ?? []);
  for (const check of checks) {
    const last = runtimeScenarios[runtimeScenarios.length - 1];
    if (last?.slug === check.scenario) last.checks.push(check);
    else runtimeScenarios.push({ slug: check.scenario, title: titles.get(check.scenario) ?? check.scenario, checks: [check] });
  }
  if (!compiled) return runtimeScenarios.map(toChecklistScenario);

  const runtimeByScenario = new Map(runtimeScenarios.map((scenario) => [scenario.slug, scenario]));
  const definitionByName = new Map(compiled.checks.map((check) => [check.name, check]));
  const scenarios: PlanChecklistScenario[] = [];
  for (const definition of orderedScenarios(compiled)) {
    const runtime = runtimeByScenario.get(definition.slug);
    const runtimeGroups = groupChecks(runtime?.checks ?? []);
    const runtimeGroupByName = new Map(runtimeGroups.map((group) => [group.name, group]));
    const groups = definition.checks.flatMap((name) => {
      const materialized = runtimeGroupByName.get(name);
      if (materialized) return [materialized];
      const check = definitionByName.get(name);
      if (check?.target?.selection !== "each") return [];
      return [{
        key: `${definition.slug}:${check.name}`,
        name: check.name,
        role: check.target.role,
        operation: check.operation,
        each: true,
        checks: [],
      } satisfies PlanChecklistGroup];
    });
    for (const group of runtimeGroups) if (!definition.checks.includes(group.name)) groups.push(group);
    if (groups.length === 0) continue;
    const materializedChecks = runtime?.checks ?? [];
    scenarios.push({
      slug: definition.slug,
      title: definition.title,
      groups,
      satisfied: materializedChecks.filter((check) => check.state === "SATISFIED").length,
      total: materializedChecks.length,
      actionable: materializedChecks.some((check) => check.actionable),
      rejected: materializedChecks.some((check) => check.state === "OPEN" && check.latestVerdict === "NOT_VALIDATED"),
    });
  }
  for (const runtime of runtimeScenarios) if (!compiled.scenarios.some((scenario) => scenario.slug === runtime.slug)) scenarios.push(toChecklistScenario(runtime));
  return scenarios;
}

function toChecklistScenario(scenario: { slug: string; title: string; checks: PlanCheck[] }): PlanChecklistScenario {
  return {
    slug: scenario.slug,
    title: scenario.title,
    groups: groupChecks(scenario.checks),
    satisfied: scenario.checks.filter((check) => check.state === "SATISFIED").length,
    total: scenario.checks.length,
    actionable: scenario.checks.some((check) => check.actionable),
    rejected: scenario.checks.some((check) => check.state === "OPEN" && check.latestVerdict === "NOT_VALIDATED"),
  };
}

function groupChecks(checks: readonly PlanCheck[]): PlanChecklistGroup[] {
  const groups: Array<{ key: string; name: string; role: string; operation: string; each: boolean; checks: PlanCheck[] }> = [];
  for (const check of checks) {
    const last = groups[groups.length - 1];
    if (last && last.name === check.name) last.checks.push(check);
    else groups.push({
      key: `${check.scenario}:${check.name}`,
      name: check.name,
      role: check.target.role,
      operation: check.operation,
      each: check.target.selection === "each",
      checks: [check],
    });
  }
  return groups;
}

function checkState(check: PlanCheck): "satisfied" | "notValidated" | "next" | "waiting" {
  if (check.state === "SATISFIED") return "satisfied";
  if (check.latestVerdict === "NOT_VALIDATED") return "notValidated";
  return check.actionable ? "next" : "waiting";
}

function CheckStateIcon({ state }: { state: ReturnType<typeof checkState> }) {
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
      <StateGlyph state={state} />
    </span>
  );
}

type ScenarioState = "satisfied" | "notValidated" | "current" | "waiting" | "noInstances";

function scenarioState(scenario: Pick<PlanChecklistScenario, "satisfied" | "total" | "actionable" | "rejected">): ScenarioState {
  if (scenario.total === 0) return "noInstances";
  if (scenario.satisfied === scenario.total) return "satisfied";
  if (scenario.rejected) return "notValidated";
  return scenario.actionable ? "current" : "waiting";
}

function ScenarioStateIcon({ state }: { state: ScenarioState }) {
  return <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true"><StateGlyph state={state} /></span>;
}

function StateGlyph({ state }: { state: ReturnType<typeof checkState> | ScenarioState }) {
  if (state === "satisfied") return <CheckCircle2 size={16} className="text-success" />;
  if (state === "notValidated") return <XCircle size={16} className="text-danger" />;
  if (state === "next" || state === "current") return <Play size={15} className="fill-current text-accent" />;
  if (state === "noInstances") return <Circle size={15} className="text-faint" />;
  return <Pause size={15} className="fill-current text-muted" />;
}
