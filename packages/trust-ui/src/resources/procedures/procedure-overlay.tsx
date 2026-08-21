import { Activity, BookOpen, Braces, Copy, FileCode2, FlaskConical, Network, Pencil, TerminalSquare, Upload } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import { GherkinEditor } from "../../gherkin-editor.js";
import { plural } from "../../lib/format.js";
import { mutationError, usePublishProcedure } from "../../lib/mutations.js";
import { useExpert, usePreference, useResolvedTheme } from "../../lib/preferences.js";
import { useOperations, usePlans, useProcedures, useRuntime } from "../../lib/runtime-context.js";
import type { CompiledProcedure } from "../../types.js";
import { Badge, StatusBadge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { Expert } from "../../ui/expert.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { EmptyState, ErrorBox, LoadingState } from "../../ui/states.js";
import { EmptyRelation, InspectorSection, RelationLink } from "../shared/inspector.js";
import { useCloseTo } from "../shared/origin.js";
import { useOverlayViewState } from "../shared/overlay-state.js";
import { ResourceOverlay } from "../shared/resource-overlay.js";
import { useSourceDraft } from "../shared/source-draft.js";
import { orderedScenarios, procedureTemplate } from "./model.js";
import { ProcedureGraph } from "./procedure-graph.js";
import { ProcedureOverview } from "./procedure-overview.js";
import { ProcedureSimulation } from "./procedure-simulation.js";
import { PlansMark } from "./procedures-home.js";

type Tab = "overview" | "source" | "dag" | "simulation" | "contract";
const TABS: readonly Tab[] = ["overview", "source", "dag", "simulation", "contract"];
/** The Compiled JSON tab is expert-only: in operator mode a `?tab=contract` URL falls back to the default tab. */
const OPERATOR_TABS: readonly Tab[] = TABS.filter((tab) => tab !== "contract");

export function ProcedureOverlay({ mode = "item" }: { mode?: "item" | "new" }) {
  const params = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const expert = useExpert();
  const runtime = useRuntime();
  const theme = useResolvedTheme();
  const editorFontSize = usePreference("editorFontSize");
  const procedures = useProcedures();
  const operations = useOperations();
  const plans = usePlans();

  const id = mode === "new" ? undefined : decodeURIComponent(params.procedure ?? "");
  const published = id ? procedures.data?.find(({ procedure }) => procedure.procedure === id) : undefined;
  const draft = useSourceDraft({
    mode, id, catalogSource: published?.procedure.source, template: procedureTemplate, compileKey: "procedure.compile",
    seedSource: (from) => procedures.data?.find(({ procedure }) => procedure.procedure === from)?.procedure.source,
    compile: (source) => runtime.compileProcedure(source),
  });
  const { source, setDraft, authoring, listSearch, compileError, markers } = draft;
  const seed = draft.from ? procedures.data?.find(({ procedure }) => procedure.procedure === draft.from) : undefined;
  const view = useOverlayViewState<Tab>(expert ? TABS : OPERATOR_TABS, mode === "new" ? "source" : "overview");
  const { tab, setTab, sel: selectedNode, setSel: setSelectedNode } = view;
  const close = useCloseTo(`/procedures${listSearch}`);
  const compiled: CompiledProcedure | undefined = authoring ? draft.compiled : published?.procedure;
  const status = draft.status === "CURRENT" ? "PUBLISHED" : draft.status;

  const publish = usePublishProcedure();
  const onPublish = () => publish.mutate(source, { onSuccess: (value) => draft.settle(`/procedures/${encodeURIComponent(value.procedure.procedure)}`, tab === "overview" ? undefined : tab) });
  const publishError = mutationError(publish.error);

  const executing = useMemo(() => (plans.data ?? []).filter((plan) => plan.procedure === (compiled?.procedure ?? id)), [plans.data, compiled?.procedure, id]);
  const active = executing.filter((plan) => plan.workState === "IN_PROGRESS");
  const usedOperations = compiled?.operations ?? [];
  const inputs = compiled?.roles.filter((role) => (role.source as { kind?: string }).kind === "plan-input") ?? [];

  const title = compiled?.title ?? published?.procedure.title ?? (mode === "new" ? t("procedures.overlay.newTitle") : (id ?? ""));
  const version = compiled?.version ?? published?.procedure.version;
  const displayId = compiled?.procedure ?? published?.procedure.procedure ?? (mode === "new" ? t("procedures.overlay.unnamed") : (id ?? ""));
  const notFound = mode === "item" && procedures.isSuccess && !published;
  const crumbs = [{ label: t("procedures.crumbRoot"), to: "/overview" }, { label: t("procedures.crumbProcedures"), to: `/procedures${listSearch}` }, { label: displayId, mono: true }];
  // The id already ends the breadcrumb: the header repeats it for experts only (and when a duplication origin must be shown).
  const idLine = seed ? t("procedures.overlay.duplicatedFrom", { id: displayId, from: seed.procedure.procedure }) : displayId;
  const tabs: Array<{ value: Tab; label: ReactNode }> = [
    { value: "overview", label: <><BookOpen size={13} /> {t("procedures.overlay.tabs.overview")}</> },
    { value: "source", label: <><FileCode2 size={13} /> {t("procedures.overlay.tabs.source")}</> },
    { value: "dag", label: <><Network size={13} /> {t("procedures.overlay.tabs.graph")}</> },
    { value: "simulation", label: <><FlaskConical size={13} /> {t("procedures.overlay.tabs.simulate")}</> },
    ...(expert ? [{ value: "contract" as const, label: <><Braces size={13} /> {t("procedures.overlay.tabs.contract")}</> }] : []),
  ];

  return (
    <ResourceOverlay
      onClose={close}
      crumbs={crumbs}
      labelledBy="procedure-title"
      kicker={version ? t("procedures.overlay.kickerVersion", { version }) : t("procedures.overlay.kicker")}
      badges={<><StatusBadge state={status} />{published ? <PlansMark plans={executing.length} active={active.length} /> : null}</>}
      id={expert || seed ? idLine : ""}
      title={title}
      loading={
        procedures.isLoading ? <LoadingState /> : notFound ? (
          <div className="p-8">
            <EmptyState title={t("procedures.overlay.notFoundTitle", { id: id ?? "" })} action={<Button onClick={close}>{t("procedures.overlay.backToList")}</Button>} />
          </div>
        ) : undefined
      }
      actions={
        <>
          {published ? <Button size="sm" icon={<Copy size={13} />} onClick={() => navigate(`/procedures/new?from=${encodeURIComponent(published.procedure.procedure)}`)}>{t("common.actions.duplicate")}</Button> : null}
          <Button size="sm" icon={<FlaskConical size={13} />} onClick={() => setTab("simulation")}>{t("procedures.overlay.simulate")}</Button>
          <Button size="sm" icon={<Pencil size={13} />} onClick={() => setTab("source")}>{t("procedures.overlay.editSource")}</Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Upload size={13} />}
            disabled={publish.isPending || !authoring || Boolean(compileError) || draft.compiling}
            title={!authoring ? t("procedures.overlay.publishHintEdit") : compileError ? t("procedures.overlay.publishHintFix") : undefined}
            onClick={onPublish}
          >
            {publish.isPending ? t("procedures.overlay.publishing") : t("procedures.overlay.publish")}
          </Button>
        </>
      }
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      tabMeta={
        compileError ? <span className="text-danger">{compileError.location ? t("procedures.overlay.compileLocation", { detail: compileError.detail, line: String(compileError.location.line) }) : compileError.detail}</span>
        : publishError ? <span className="text-danger">{publishError}</span>
        : compiled ? `${plural(compiled.scenarios.length, "scenario")} · ${plural(compiled.checks.length, "check")}` : ""
      }
      inspector={
        <>
          {/* Plans count lives in the header mark (running · total); operations count in the Uses section. */}
          <InspectorSection title={t("procedures.overlay.executedBy")}>
            {executing.length === 0 ? <EmptyRelation>{t("procedures.overlay.noPlanYet")}</EmptyRelation> : null}
            {[...active, ...executing.filter((plan) => plan.workState !== "IN_PROGRESS")].map((plan) => (
              <RelationLink key={plan.plan} to={`/plans/${encodeURIComponent(plan.plan)}`} icon={<Activity />} title={plan.plan} meta={t(expert ? "procedures.overlay.planMetaRev" : "procedures.overlay.planMeta", { environment: plan.environment, satisfied: String(plan.satisfiedChecks), total: String(plan.checkCount), revision: String(plan.revision) })} state={<Badge tone={plan.workState === "IN_PROGRESS" ? "info" : "success"}>{plan.workState.replace("_", " ")}</Badge>} />
            ))}
          </InspectorSection>
          <InspectorSection title={t("procedures.overlay.uses")} count={usedOperations.length}>
            {usedOperations.length === 0 ? <EmptyRelation>{t("procedures.overlay.noOperationYet")}</EmptyRelation> : null}
            {usedOperations.map((used) => (
              <RelationLink key={`${used.operation}@${used.version}`} to={`/operations/${encodeURIComponent(used.operation)}`} icon={<TerminalSquare />} title={used.operation} meta={expert ? t("procedures.overlay.usedMeta", { title: used.definition.title, version: used.version }) : used.definition.title} />
            ))}
          </InspectorSection>
          <Expert>
            {compiled ? (
              <>
                <InspectorSection title={t("procedures.overlay.planInputs")} count={inputs.length}>
                  {inputs.length === 0 ? <EmptyRelation>{t("procedures.overlay.noPlanInput")}</EmptyRelation> : null}
                  {inputs.map((role) => (
                    <div key={role.name} className="flex items-baseline justify-between gap-2 py-0.5 text-body">
                      <span className="mono">{role.name}</span>
                      <span className="text-caption text-faint">{role.type} · {role.cardinality}</span>
                    </div>
                  ))}
                </InspectorSection>
                <InspectorSection title={t("procedures.overlay.scenarios")}>
                  {orderedScenarios(compiled).map((scenario, index) => (
                    <button key={scenario.slug} type="button" onClick={() => view.update({ tab: "dag", sel: `scenario:${scenario.slug}` })} title={t("procedures.overlay.showInGraph")} className="flex items-center gap-2 rounded-(--radius-1) px-1.5 py-1 text-left hover:bg-surface-2">
                      <span className="w-4 text-right text-caption text-faint">{index + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate-1 text-body font-medium">{scenario.title}</span>
                        <span className="block text-caption text-muted">{plural(scenario.checks.length, "check")}{scenario.dependencies.length ? ` · ${t("procedures.overlay.afterList", { list: scenario.dependencies.join(", ") })}` : ""}</span>
                      </span>
                    </button>
                  ))}
                </InspectorSection>
              </>
            ) : null}
          </Expert>
        </>
      }
    >
      {tab === "overview" ? <ProcedureOverview compiled={compiled} error={compileError?.detail} /> : null}
      {tab === "source" ? (
        <GherkinEditor kind="procedure" value={source} onChange={setDraft} theme={theme} languageServerUrl={runtime.languageServerUrl()} markers={markers} fontSize={editorFontSize} />
      ) : null}
      {tab === "dag" ? (
        compiled ? (
          <div className="h-full">
            <ProcedureGraph procedure={compiled} selected={selectedNode} onSelect={setSelectedNode} />
          </div>
        ) : <div className="p-6"><EmptyState icon={<Network />} title={t("procedures.overlay.noGraphTitle")} body={compileError?.detail ?? t("procedures.overlay.mustCompile")} /></div>
      ) : null}
      {tab === "simulation" ? <ProcedureSimulation compiled={compiled} error={compileError?.detail} /> : null}
      {tab === "contract" ? (
        compiled ? <div className="h-full min-h-0"><JsonViewer value={compiled} /></div>
          : <div className="p-6"><EmptyState icon={<Braces />} title={t("procedures.overlay.noContractTitle")} body={compileError?.detail ?? t("procedures.overlay.mustCompile")} /></div>
      ) : null}
      {publishError && tab !== "source" ? <div className="p-4"><ErrorBox message={publishError} /></div> : null}
    </ResourceOverlay>
  );
}
