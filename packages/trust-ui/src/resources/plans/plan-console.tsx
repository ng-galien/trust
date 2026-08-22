import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, FlaskConical, PanelRightClose, Pause, Play, Send, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { plural } from "../../lib/format.js";
import { mutationError, mutationErrorDetails } from "../../lib/mutations.js";
import { useExpert } from "../../lib/preferences.js";
import { useCheck } from "../../lib/runtime-context.js";
import type { TrustRuntimeClient } from "../../runtime.js";
import type { AttemptFinalization, CompiledOperation, CompiledProcedure, DeclarationRole, JsonObject, PlanCheck, PlanView, ProcedureCheck } from "../../types.js";
import { Badge, StatusBadge } from "../../ui/badge.js";
import { Button, IconButton } from "../../ui/button.js";
import { TextInput } from "../../ui/controls.js";
import { blankObject, ListEditor, SchemaForm } from "../../ui/schema.js";
import { Expert } from "../../ui/expert.js";
import { ErrorBox } from "../../ui/states.js";
import { CheckLine } from "./plan-overlay.js";

/* Rehearsal cockpit of a dry-run, docked beside every view of the Plan: the operator plays the agent.
   1. Declare the dynamic context (the roles an agent declares) — same closed operation as MCP.
   2. Take the selected actionable Check (from the checklist, the graph or the list here), supply the values its
      Operation would produce, submit as the agent would:
      admission → Facts → finalization. TRUST qualifies and cascades for real. */

export function PlanCockpit({ plan, compiled, onChanged, runtime, selected: selection, onSelect, onClose }: { plan: PlanView; compiled: CompiledProcedure | undefined; onChanged: () => Promise<unknown>; runtime: TrustRuntimeClient; selected: string | undefined; onSelect: (id: string | undefined) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const actionable = plan.checks.filter((check) => check.actionable);
  const done = plan.checks.filter((check) => check.state === "SATISFIED");
  const waiting = plan.checks.filter((check) => check.state === "OPEN" && !check.actionable);
  const [last, setLast] = useState<{ check: string; outcome: Outcome }>();
  const [showDeclarations, setShowDeclarations] = useState(plan.missingDeclarations.length > 0);
  const [showDone, setShowDone] = useState(false);
  const [showWaiting, setShowWaiting] = useState(false);
  // The selection is shared with the views: `check:<uri>` from the checklist, `check:<name>` from the graph.
  const wanted = selection?.startsWith("check:") ? selection.slice("check:".length) : undefined;
  // A satisfied Check can be picked from the Done list to be observed again (dry-runs may re-observe).
  const wantedCheck = plan.checks.find((check) => check.checkUri === wanted || check.name === wanted);
  const selected = wantedCheck && (wantedCheck.actionable || wantedCheck.state === "SATISFIED") ? wantedCheck : actionable[0];
  const reobserve = selected?.state === "SATISFIED";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto [&>*]:shrink-0">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FlaskConical size={13} className="text-graph-data" />
        <span className="kicker">{t("plans.cockpit.title")}</span>
        <IconButton size="sm" label={t("plans.cockpit.hide")} className="ml-auto" onClick={onClose}><PanelRightClose size={14} /></IconButton>
      </div>
      {plan.sessionState === "UNAVAILABLE" ? <ErrorBox message={t("plans.cockpit.noSession")} className="m-3" /> : null}
      {plan.declarationRoles.length ? (
        <Step number={1} title={t("plans.cockpit.declareStep")} state={plan.missingDeclarations.length ? "todo" : "done"} meta={plan.missingDeclarations.length ? t("plans.cockpit.missing", { count: plan.missingDeclarations.length }) : t("plans.cockpit.complete")} open={showDeclarations} onToggle={() => setShowDeclarations((open) => !open)}>
          <Declarations plan={plan} onChanged={onChanged} runtime={runtime} />
        </Step>
      ) : null}
      <Step number={plan.declarationRoles.length ? 2 : 1} title={t("plans.cockpit.runStep")} state={plan.workState === "COMPLETE" ? "done" : actionable.length ? "todo" : "waiting"} meta={t("plans.cockpit.runMeta", { done: done.length, actionable: actionable.length, waiting: waiting.length })} open onToggle={undefined}>
        <ul className="border-t border-border">
          <li>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-label text-muted hover:bg-surface-2" onClick={() => setShowDone((open) => !open)}>
              <CheckCircle2 size={12} className="text-success" /> {t("plans.cockpit.done")} <span className="text-faint">{done.length}</span><span className="ml-auto text-faint">{showDone ? t("plans.cockpit.hideList") : t("plans.cockpit.showList")}</span>
            </button>
            {showDone ? <ul>{done.map((check) => <li key={check.checkUri} className="border-t border-border"><CheckLine check={check} compact selected={check.checkUri === selected?.checkUri} onClick={() => onSelect(`check:${check.checkUri}`)} /></li>)}</ul> : null}
          </li>
          <li className="border-t border-border bg-accent-soft/40" data-doc="cockpit.todo">
            <div className="flex items-center gap-2 px-3 py-1.5 text-label font-medium"><Play size={12} className="fill-current text-accent" /> {t("plans.cockpit.toDoNow")} <span className="text-faint">{actionable.length}</span><span className="ml-auto text-caption font-normal text-faint">{t("plans.cockpit.pickOne")}</span></div>
            {actionable.length === 0 ? <p className="px-3 pb-2 text-body text-muted">{plan.missingDeclarations.length ? t("plans.cockpit.declareFirst") : plan.workState === "COMPLETE" ? t("plans.cockpit.rehearsalComplete") : t("plans.cockpit.nothingActionable")}</p> : null}
            <ul>{actionable.map((check) => <li key={check.checkUri} className="border-t border-border"><CheckLine check={check} compact selected={check.checkUri === selected?.checkUri} onClick={() => onSelect(`check:${check.checkUri}`)} /></li>)}</ul>
          </li>
          {waiting.length ? (
            <li className="border-t border-border">
              <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-label text-muted hover:bg-surface-2" onClick={() => setShowWaiting((open) => !open)}>
                <Pause size={12} className="fill-current" /> {t("plans.cockpit.waiting")} <span className="text-faint">{waiting.length}</span><span className="ml-auto text-faint">{showWaiting ? t("plans.cockpit.hideList") : t("plans.cockpit.showList")}</span>
              </button>
              {showWaiting ? <ul>{waiting.map((check) => <li key={check.checkUri} className="border-t border-border"><CheckLine check={check} compact onClick={() => onSelect(`check:${check.checkUri}`)} /></li>)}</ul> : null}
            </li>
          ) : null}
        </ul>
      </Step>
      <div className="flex flex-col gap-3 p-3">
        {selected ? <div className="flex items-center gap-2"><StepNumber number={plan.declarationRoles.length ? 3 : 2} state="todo" /><span className="text-body font-medium">{reobserve ? t("plans.cockpit.reobserveSelected") : t("plans.cockpit.rehearseSelected")}</span></div> : null}
        {last ? <div data-doc="cockpit.outcome"><OutcomeBanner check={last.check} outcome={last.outcome} /></div> : null}
        {selected ? <CheckWorkbench key={`${selected.checkUri}@${plan.revision}`} plan={plan} check={selected} compiled={compiled} onChanged={onChanged} runtime={runtime} reobserve={reobserve} onOutcome={(outcome) => setLast({ check: selected.name, outcome })} /> : null}
      </div>
    </div>
  );
}

/* ---------- cockpit steps ---------- */

function StepNumber({ number, state }: { number: number; state: "done" | "todo" | "waiting" }) {
  return (
    <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-caption font-semibold ${state === "done" ? "bg-success text-accent-contrast" : state === "todo" ? "bg-accent text-accent-contrast" : "bg-surface-3 text-muted"}`}>
      {state === "done" ? <CheckCircle2 size={12} /> : number}
    </span>
  );
}

function Step({ number, title, state, meta, open, onToggle, children }: { number: number; title: string; state: "done" | "todo" | "waiting"; meta: string; open: boolean; onToggle: (() => void) | undefined; children: React.ReactNode }) {
  const { t } = useTranslation();
  const header = (
    <>
      <StepNumber number={number} state={state} />
      <span className="text-body font-medium">{title}</span>
      <span className="ml-auto text-caption text-faint">{meta}{onToggle ? ` · ${open ? t("plans.cockpit.hideList") : t("plans.cockpit.showList")}` : ""}</span>
    </>
  );
  return (
    <section className="border-b border-border">
      {onToggle ? <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2" onClick={onToggle}>{header}</button> : <div className="flex items-center gap-2 px-3 py-2">{header}</div>}
      {open ? children : null}
    </section>
  );
}

/* ---------- declarations ---------- */

function Declarations({ plan, onChanged, runtime }: { plan: PlanView; onChanged: () => Promise<unknown>; runtime: TrustRuntimeClient }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<JsonObject>(plan.declarations);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(plan.declarations); }, [plan.declarations, plan.revision, dirty]);
  const apply = useMutation({
    mutationFn: () => runtime.replaceDeclarations(plan.plan, plan.revision, compact(draft)),
    onSuccess: async () => { setDirty(false); await onChanged(); },
  });
  const error = mutationError(apply.error);
  const errorDetails = mutationErrorDetails(apply.error);
  const set = (role: string, value: unknown) => { setDraft((current) => ({ ...current, [role]: value })); setDirty(true); };
  if (plan.declarationRoles.length === 0) return null;
  return (
    <section className="border-t border-border bg-bg">
      <div className="flex flex-col gap-3 p-3">
        {plan.declarationRoles.map((role) => (
          <DeclarationField key={role.role} role={role} value={draft[role.role]} plan={plan} missing={plan.missingDeclarations.includes(role.role)} onChange={(value) => set(role.role, value)} />
        ))}
        {error ? <ErrorBox message={error} details={errorDetails} /> : null}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" icon={<Send size={12} />} disabled={!dirty || apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? t("plans.declarations.applying") : t("plans.declarations.apply")}</Button>
          <Expert><span className="text-caption text-faint">{t("plans.declarations.replacesSnapshot", { revision: plan.revision })} <span className="mono">trust_plan_declarations_replace</span></span></Expert>
        </div>
      </div>
    </section>
  );
}

function DeclarationField({ role, value, plan, missing, onChange }: { role: DeclarationRole; value: unknown; plan: PlanView; missing: boolean; onChange: (value: unknown) => void }) {
  const { t } = useTranslation();
  const eachParent = role.parents.find((parent) => parent.each);
  const scalarSpec = role.type === "number" ? { type: "number" } : { type: "string", minLength: 1 };
  const label = (
    <div className="flex items-baseline gap-2">
      <span className="mono text-body-lg font-medium">{role.role}</span>
      <span className="text-caption text-faint">{role.cardinality} {role.type}{role.parents.length ? ` · ${t("plans.declarations.forParents", { parents: role.parents.map((parent) => (parent.each ? t("plans.declarations.eachParent", { role: parent.role }) : parent.role)).join(", ") })}` : ""}</span>
      {missing ? <Badge tone="warning">{t("plans.declarations.missing")}</Badge> : null}
    </div>
  );
  if (eachParent) {
    // One value per current parent value: [{ value, parents: [{ role, value }] }]
    const parentValues = knownValues(plan, eachParent.role);
    const entries = Array.isArray(value) ? value as Array<{ value: unknown; parents: Array<{ role: string; value: unknown }> }> : [];
    const valueFor = (parent: unknown) => entries.find((entry) => JSON.stringify(entry.parents?.[0]?.value) === JSON.stringify(parent))?.value;
    const setFor = (parent: unknown, next: unknown) => {
      const others = entries.filter((entry) => JSON.stringify(entry.parents?.[0]?.value) !== JSON.stringify(parent));
      onChange(next === "" || next === undefined ? others : [...others, { value: next, parents: [{ role: eachParent.role, value: parent }] }]);
    };
    return (
      <div className="flex flex-col gap-1">
        {label}
        {parentValues.length === 0 ? <p className="text-label text-faint"><Trans i18nKey="plans.declarations.declareParentFirst" values={{ role: eachParent.role }} components={{ mono: <span className="mono" /> }} /></p> : (
          <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
            {parentValues.map((parent) => (
              <ScalarInput key={JSON.stringify(parent)} prefix={<span className="mono text-label text-muted">{String(parent)}</span>} type={role.type} value={valueFor(parent)} onChange={(next) => setFor(parent, next)} />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (role.cardinality === "many") {
    return <div className="flex flex-col gap-1">{label}<ListEditor id={`decl-${role.role}`} spec={scalarSpec} value={Array.isArray(value) ? value : []} onChange={(next) => onChange(next.length ? next : undefined)} /></div>;
  }
  return <div className="flex flex-col gap-1">{label}<ScalarInput type={role.type} value={value} onChange={onChange} /></div>;
}

function ScalarInput({ type, value, onChange, prefix }: { type: string; value: unknown; onChange: (value: unknown) => void; prefix?: React.ReactNode }) {
  const input = (
    <TextInput
      className="h-7 w-full text-body"
      type={type === "number" ? "number" : "text"}
      value={value === undefined ? "" : String(value)}
      onChange={(event) => onChange(event.target.value === "" ? undefined : type === "number" ? Number(event.target.value) : event.target.value)}
    />
  );
  return prefix ? <>{prefix}{input}</> : input;
}

/** Values a parent role currently has: root input, declaration (plain or coordinated). Produced roles are not declarable against. */
function knownValues(plan: PlanView, role: string): unknown[] {
  const fromRoot = plan.rootInputs[role];
  if (fromRoot !== undefined) return Array.isArray(fromRoot) ? fromRoot : [fromRoot];
  const declared = plan.declarations[role];
  if (Array.isArray(declared)) return declared.map((entry) => (entry !== null && typeof entry === "object" && "value" in (entry as object) ? (entry as { value: unknown }).value : entry));
  return declared === undefined ? [] : [declared];
}

function compact(declarations: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(declarations).filter(([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)));
}

/* ---------- one Check ---------- */

type Outcome = AttemptFinalization | { refused: string };

function OutcomeBanner({ check, outcome }: { check: string; outcome: Outcome }) {
  const { t } = useTranslation();
  if ("refused" in outcome) return <ErrorBox message={t("plans.outcome.refused", { check, reason: outcome.refused })} />;
  return (
    <div className={`rounded-(--radius-2) border p-2 text-body ${outcome.verdict === "VALIDATED" ? "border-success/40 bg-success-soft" : "border-danger/40 bg-danger-soft"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {outcome.verdict === "VALIDATED" ? <CheckCircle2 size={14} className="text-success" /> : <XCircle size={14} className="text-danger" />}
        <span className="mono font-medium">{check}</span>
        <StatusBadge state={outcome.verdict} />
        <span>{outcome.reason}</span>
        <Expert><span className="text-faint">({outcome.reasonCode})</span></Expert>
      </div>
      <p className="mt-1 text-label text-muted">
        {outcome.checklistDelta.newlySatisfied.length ? t("plans.outcome.newlySatisfied", { checks: plural(outcome.checklistDelta.newlySatisfied.length, "check") }) : t("plans.outcome.nothingSatisfied")}
        {outcome.checklistDelta.newlyOpened.length ? ` · ${t("plans.outcome.reopenedBelow", { checks: plural(outcome.checklistDelta.newlyOpened.length, "check") })}` : ""}
        {outcome.checklistDelta.unchanged.length ? ` · ${t("plans.outcome.unchanged", { checks: plural(outcome.checklistDelta.unchanged.length, "check") })}` : ""}
      </p>
    </div>
  );
}

function CheckWorkbench({ plan, check, compiled, onChanged, runtime, reobserve = false, onOutcome }: { plan: PlanView; check: PlanCheck; compiled: CompiledProcedure | undefined; onChanged: () => Promise<unknown>; runtime: TrustRuntimeClient; reobserve?: boolean; onOutcome: (outcome: Outcome) => void }) {
  const { t } = useTranslation();
  const definition: CompiledOperation | undefined = compiled?.operations.find((entry) => entry.operation === check.operation)?.definition;
  const compiledCheck: ProcedureCheck | undefined = compiled?.checks.find((entry) => entry.name === check.name);
  const schema = definition?.produced;
  // What this Check already observed (a reopened Check should be re-run with the values it established, unless you decide otherwise).
  const history = useCheck(check.checkUri);
  const previous = useMemo(() => {
    // Most recent admission first (the runtime's order is not guaranteed).
    const attempts = [...(history.data?.attempts ?? [])].sort((a, b) => b.admittedAt.localeCompare(a.admittedAt));
    for (const attempt of attempts) {
      const fact = attempt.facts.at(-1);
      if (fact?.values) return fact.values;
    }
    return undefined;
  }, [history.data]);
  const [values, setValues] = useState<JsonObject>(() => (schema ? blankObject(schema) : {}));
  const [seeded, setSeeded] = useState(false);
  useEffect(() => { if (previous && !seeded) { setValues(previous); setSeeded(true); } }, [previous, seeded]);
  const [valid, setValid] = useState(false);
  const [nextIntent, setNextIntent] = useState("");
  useEffect(() => { setNextIntent(""); }, [plan.currentIntent, check.checkUri]);
  const intentReady = !plan.intentChaining || check.completesPlan || nextIntent.trim().length > 0;

  const submit = useMutation({
    mutationFn: async () => {
      const admission = await runtime.admitCheck(check.checkUri, `simulate-${check.name}-${Date.now().toString(36)}`, {
        reobserve,
        ...(plan.intentChaining && plan.currentIntent !== null ? { intent: plan.currentIntent } : {}),
        ...(plan.intentChaining && !check.completesPlan ? { nextIntent: nextIntent.trim() } : {}),
      });
      if (admission.status !== "ADMITTED") return { refused: `${admission.reasonCode}: ${admission.reason}` };
      await runtime.postFacts({ attemptKey: admission.attemptKey, attemptHandle: admission.attemptHandle, checkUri: admission.checkUri, operation: admission.operation.operation }, values);
      return runtime.finalizeAttempt(admission.attemptHandle);
    },
    onSuccess: async (outcome) => { onOutcome(outcome); await onChanged(); },
  });
  const error = mutationError(submit.error);
  const errorDetails = mutationErrorDetails(submit.error);
  const expert = useExpert();

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-(--radius-3) border border-border bg-bg p-3">
        <div className="flex items-baseline gap-2"><span className="kicker">{t("plans.workbench.next")}</span><strong className="mono text-ui">{check.name}</strong>{expert ? <span className="text-caption text-muted">{check.scenario}</span> : null}</div>
        {expert ? (
          <>
            <p className="mt-1 text-body text-muted">{t("plans.workbench.runs")} <span className="mono text-accent">{check.operation}</span> {t("plans.workbench.on")} <span className="mono text-text">{check.target.role}</span> = <span className="mono text-text">{JSON.stringify(check.target.value)}</span></p>
            {Object.keys(check.inputs).length ? <p className="mt-1 text-label text-muted">{t("plans.workbench.inputs")} {Object.entries(check.inputs).map(([key, value], index) => <span key={key}>{index ? " · " : ""}<span className="mono">{key}</span> = <span className="mono text-text">{JSON.stringify(value)}</span></span>)}</p> : null}
            {compiledCheck?.successReason ? <p className="mt-1 text-body">{t("plans.workbench.mustEstablish")} <em>“{compiledCheck.successReason}”</em></p> : null}
            {compiledCheck ? <pre className="mono mt-2 overflow-x-auto whitespace-pre-wrap rounded-(--radius-1) bg-surface-2 p-2 text-label text-text"><code>{compiledCheck.qualification.source}</code></pre> : null}
          </>
        ) : null}
      </section>
      <section className="rounded-(--radius-3) border border-border bg-bg p-3" data-doc="cockpit.workbench">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="kicker">{t("plans.workbench.producedValues")}</span>
        </div>
        {plan.intentChaining ? (
          <div className="mb-3 rounded-(--radius-2) border border-border bg-surface-2 p-2">
            <p className="text-label text-muted">{t("plans.workbench.currentIntent")}</p>
            <p className="mt-0.5 text-body text-text">{plan.currentIntent}</p>
            {check.completesPlan ? (
              <p className="mt-2 text-label text-muted">{t("plans.workbench.finalIntent")}</p>
            ) : (
              <label className="mt-2 block text-label text-muted">
                {t("plans.workbench.nextIntent")}
                <TextInput className="mt-1 h-7 w-full text-body" value={nextIntent} onChange={(event) => setNextIntent(event.target.value)} placeholder={t("plans.workbench.nextIntentPlaceholder")} />
              </label>
            )}
          </div>
        ) : null}
        {schema ? <SchemaForm idPrefix={`facts-${check.name}`} schema={schema} value={values} onChange={setValues} onValidity={setValid} showSummary={false} /> : <p className="text-body text-faint">{t("plans.workbench.needsProcedure")}</p>}
        <div className="mt-3">
          <Button data-doc="cockpit.submit" variant="primary" icon={<FlaskConical size={13} />} disabled={!valid || !intentReady || submit.isPending || plan.sessionState === "UNAVAILABLE"} onClick={() => submit.mutate()}>{submit.isPending ? t("plans.workbench.submitting") : t("plans.workbench.submit")}</Button>
        </div>
        {error ? <ErrorBox message={error} details={errorDetails} className="mt-2" /> : null}
      </section>
    </div>
  );
}
