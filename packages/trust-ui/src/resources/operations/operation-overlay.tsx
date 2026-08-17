import { BookOpen, Braces, Copy, FileCode2, FlaskConical, GitBranch, Pencil, Play, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import { GherkinEditor } from "../../gherkin-editor.js";
import { plural } from "../../lib/format.js";
import { mutationError, useRemoveOperation, useSaveOperation } from "../../lib/mutations.js";
import { useExpert, usePreference, useResolvedTheme } from "../../lib/preferences.js";
import { useOperationEnvironments, useOperations, useProcedures, useRuntime } from "../../lib/runtime-context.js";
import type { CompiledOperation, JsonObject } from "../../types.js";
import { Badge, StatusBadge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { ConfirmDialog } from "../../ui/confirm.js";
import { Expert } from "../../ui/expert.js";
import { constraintLabel, schemaProperties, typeLabel } from "../../ui/schema.js";
import { EmptyState, ErrorBox, LoadingState } from "../../ui/states.js";
import { EmptyRelation, InspectorSection, RelationLink } from "../shared/inspector.js";
import { useCloseTo } from "../shared/origin.js";
import { useOverlayViewState } from "../shared/overlay-state.js";
import { ResourceOverlay } from "../shared/resource-overlay.js";
import { useSourceDraft } from "../shared/source-draft.js";
import { ContractView } from "./contract-view.js";
import { operationTemplate, schemaKeys, stepTypeLabel } from "./model.js";
import { RunnableMark } from "./operations-home.js";
import { OverviewView } from "./overview-view.js";
import { RunView } from "./run-view.js";
import { SimulationView } from "./simulation-view.js";

type Tab = "overview" | "source" | "simulation" | "run" | "contract";
const TABS: readonly Tab[] = ["overview", "source", "simulation", "run", "contract"];
/** The Contract JSON tab is expert-only; a `?tab=contract` URL falls back to the default tab in operator mode. */
const OPERATOR_TABS: readonly Tab[] = TABS.filter((tab) => tab !== "contract");

export function OperationOverlay({ mode = "item" }: { mode?: "item" | "new" }) {
  const { t } = useTranslation();
  const params = useParams();
  const navigate = useNavigate();
  const runtime = useRuntime();
  const theme = useResolvedTheme();
  const expert = useExpert();
  const editorFontSize = usePreference("editorFontSize");
  const operations = useOperations();
  const procedures = useProcedures();
  const operationEnvironments = useOperationEnvironments();

  const id = mode === "new" ? undefined : decodeURIComponent(params.operation ?? "");
  const catalog = id ? operations.data?.find((operation) => operation.operation === id) : undefined;
  const draft = useSourceDraft({
    mode, id, catalogSource: catalog?.source, template: operationTemplate, compileKey: "operation.compile",
    seedSource: (from) => operations.data?.find((operation) => operation.operation === from)?.source,
    compile: (source) => runtime.compileOperation(source),
  });
  const { source, setDraft, authoring, listSearch, compileError, markers } = draft;
  const seed = draft.from ? operations.data?.find((operation) => operation.operation === draft.from) : undefined;
  const { tab, setTab } = useOverlayViewState<Tab>(expert ? TABS : OPERATOR_TABS, mode === "new" ? "source" : "overview");
  const close = useCloseTo(`/operations${listSearch}`);
  // While authoring, the live compilation is the truth; otherwise the catalog copy is.
  const compiled: CompiledOperation | undefined = authoring ? draft.compiled : catalog;
  const status = draft.status === "CURRENT" ? "COMPILED" : draft.status;
  const usedBy = useMemo(
    () => (procedures.data ?? []).filter(({ procedure }) => procedure.operations.some((used) => used.operation === (compiled?.operation ?? id))),
    [procedures.data, compiled?.operation, id],
  );

  // Save writes `<operation>.feature` into the catalog directory; the runtime recompiles and republishes the catalog.
  const save = useSaveOperation();
  const remove = useRemoveOperation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const onSave = () => save.mutate({ source, sourceName: `${compiled!.operation}.feature` }, {
    onSuccess: ({ operation }) => draft.settle(`/operations/${encodeURIComponent(operation.operation)}`, tab === "overview" ? undefined : tab),
  });
  const onDelete = () => remove.mutate({ operation: catalog!.operation, version: catalog!.version }, { onSuccess: () => navigate(`/operations${listSearch}`, { replace: true }) });
  const saveError = mutationError(save.error ?? remove.error);
  const canSave = Boolean(compiled) && !compileError && !draft.compiling && authoring && !save.isPending;

  const title = compiled?.title ?? catalog?.title ?? (mode === "new" ? t("operations.overlay.newTitle") : (id ?? ""));
  const version = compiled?.version ?? catalog?.version;
  const displayId = compiled?.operation ?? catalog?.operation ?? (mode === "new" ? t("operations.overlay.unnamed") : (id ?? ""));
  const notFound = mode === "item" && operations.isSuccess && !catalog;

  const crumbs = [{ label: "TRUST", to: "/overview" }, { label: t("operations.overlay.crumb"), to: `/operations${listSearch}` }, { label: displayId, mono: true }];
  const runnableOn = catalog ? operationEnvironments.data?.find((entry) => entry.operation === catalog.operation && entry.version === catalog.version)?.environments.filter((entry) => entry.compatible).map((entry) => entry.name) : undefined;

  return (
    <ResourceOverlay
      onClose={close}
      crumbs={crumbs}
      labelledBy="operation-title"
      kicker={version ? t("operations.overlay.kickerVersion", { version }) : t("operations.overlay.kicker")}
      badges={<><StatusBadge state={status} />{catalog ? <RunnableMark environments={runnableOn} /> : null}</>}
      // The crumb already carries the id: the header repeats it in expert mode only (the duplication origin is an authoring fact, shown in both).
      id={seed ? t("operations.overlay.duplicatedFrom", { id: displayId, from: seed.operation }) : expert ? displayId : ""}
      title={title}
      loading={
        operations.isLoading ? <LoadingState /> : notFound ? (
          <div className="p-8">
            <EmptyState title={t("operations.overlay.notFoundTitle", { id: id ?? "" })} action={<Button onClick={close}>{t("operations.overlay.backToList")}</Button>} />
          </div>
        ) : undefined
      }
      actions={
        <>
          {catalog ? <Button size="sm" icon={<Copy size={13} />} onClick={() => navigate(`/operations/new?from=${encodeURIComponent(catalog.operation)}`)}>{t("common.actions.duplicate")}</Button> : null}
          <Button size="sm" icon={<FlaskConical size={13} />} onClick={() => setTab("simulation")}>{t("operations.overlay.simulate")}</Button>
          <Button size="sm" icon={<Play size={13} />} onClick={() => setTab("run")}>{t("operations.overlay.run")}</Button>
          <Button size="sm" icon={<Pencil size={13} />} onClick={() => setTab("source")}>{t("operations.overlay.editSource")}</Button>
          {catalog && usedBy.length === 0 ? <Button size="sm" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)} disabled={remove.isPending}>{t("common.actions.delete")}</Button> : null}
          <Button size="sm" variant="primary" icon={<Save size={13} />} disabled={!canSave} onClick={onSave}>{save.isPending ? t("common.actions.saving") : t("common.actions.save")}</Button>
          <ConfirmDialog
            open={confirmDelete}
            title={t("operations.overlay.deleteTitle", { operation: catalog?.operation ?? "" })}
            body={t("operations.overlay.deleteBody")}
            confirmLabel={t("common.actions.delete")}
            tone="danger"
            busy={remove.isPending}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => { setConfirmDelete(false); onDelete(); }}
          />
        </>
      }
      tabs={[
        { value: "overview", label: <><BookOpen size={13} /> {t("operations.overlay.tabs.overview")}</> },
        { value: "source", label: <><FileCode2 size={13} /> {t("operations.overlay.tabs.source")}</> },
        { value: "simulation", label: <><FlaskConical size={13} /> {t("operations.overlay.tabs.simulate")}</> },
        { value: "run", label: <><Play size={13} /> {t("operations.overlay.tabs.run")}</> },
        ...(expert ? [{ value: "contract" as const, label: <><Braces size={13} /> {t("operations.overlay.tabs.contract")}</> }] : []),
      ]}
      tab={tab}
      onTab={setTab}
      tabMeta={compileError ? <span className="text-danger">{compileError.detail}{compileError.location ? t("operations.overlay.atLine", { line: String(compileError.location.line) }) : ""}</span> : saveError ? <span className="text-danger">{saveError}</span> : compiled ? t("operations.overlay.summary", { steps: plural(compiled.steps.length, "step"), produced: plural(schemaKeys(compiled.produced).length, "producedField") }) : ""}
      inspector={
        <>
          <InspectorSection title={t("operations.overlay.usedBy")} count={usedBy.length}>
            {usedBy.length === 0 ? <EmptyRelation>{t("operations.overlay.noProcedureUses")}</EmptyRelation> : null}
            {usedBy.map(({ procedure }) => (
              <RelationLink key={`${procedure.procedure}@${procedure.version}`} to={`/procedures/${encodeURIComponent(procedure.procedure)}`} icon={<GitBranch />} title={procedure.procedure} meta={t("operations.overlay.procedureMeta", { title: procedure.title, version: procedure.version })} />
            ))}
          </InspectorSection>
          {compiled ? (
            <Expert>
              <InspectorSection title={t("operations.overlay.interface")}>
                <SchemaList label={t("operations.overlay.input")} schema={compiled.input} />
                <SchemaList label={t("operations.overlay.environment")} schema={compiled.environment} />
                <SchemaList label={t("operations.overlay.produced")} schema={compiled.produced} />
              </InspectorSection>
              {/* The step count already sits in the tab meta line. */}
              <InspectorSection title={t("operations.overlay.steps")}>
                {compiled.steps.map((step, index) => (
                  <div key={step.name} className="flex items-center gap-2 py-1">
                    <span className="w-4 text-right text-caption text-faint">{index + 1}</span>
                    <span className="mono text-body font-medium">{step.name}</span>
                    <Badge className="ml-auto">{stepTypeLabel(step.type)}</Badge>
                  </div>
                ))}
              </InspectorSection>
            </Expert>
          ) : null}
        </>
      }
    >
      {saveError && tab !== "source" ? <div className="p-4"><ErrorBox message={saveError} /></div> : null}
      {tab === "overview" ? <OverviewView compiled={compiled} error={compileError?.detail} /> : null}
      {tab === "source" ? <GherkinEditor kind="operation" value={source} onChange={setDraft} theme={theme} markers={markers} fontSize={editorFontSize} /> : null}
      {tab === "contract" ? <ContractView compiled={compiled} error={compileError?.detail} /> : null}
      {tab === "simulation" ? <SimulationView source={source} compiled={compiled} /> : null}
      {tab === "run" ? <RunView source={source} compiled={compiled} dirty={authoring} /> : null}
    </ResourceOverlay>
  );
}

function SchemaList({ label, schema }: { label: string; schema: JsonObject }) {
  const { t } = useTranslation();
  const entries = schemaProperties(schema);
  return (
    <div className="mb-2 last:mb-0">
      <span className="text-caption font-semibold text-muted">{label}</span>
      {entries.length === 0 ? <p className="text-body text-faint">{t("operations.overlay.none")}</p> : null}
      {entries.map(({ name, spec, required }) => (
        <div key={name} className="flex items-baseline justify-between gap-2 py-0.5">
          <span className="mono text-body">{name}{required ? "" : "?"}</span>
          <span className="truncate-1 text-caption text-faint" title={constraintLabel(spec)}>{constraintLabel(spec) ? t("operations.overlay.typeConstraint", { type: typeLabel(spec), constraint: constraintLabel(spec) }) : typeLabel(spec)}</span>
        </div>
      ))}
    </div>
  );
}
