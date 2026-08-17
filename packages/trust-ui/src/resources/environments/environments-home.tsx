import { Activity, Check, FlaskConical, KeyRound, Plus, Save, Server, TerminalSquare, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useParams } from "react-router";

import { cx, plural } from "../../lib/format.js";
import { useCurrentEnvironment } from "../../lib/environment.js";
import { mutationError, useRemoveCredential, useRemoveEnvironment, useSaveCredential, useSaveEnvironment } from "../../lib/mutations.js";
import { useCredentials, useEnvironments, useOperationEnvironments, usePlans } from "../../lib/runtime-context.js";
import type { EnvironmentEntry } from "../../types.js";
import { Badge } from "../../ui/badge.js";
import { Button, IconButton } from "../../ui/button.js";
import { ConfirmDialog } from "../../ui/confirm.js";
import { Field, TextInput } from "../../ui/controls.js";
import { Expert } from "../../ui/expert.js";
import { FilterBox } from "../../ui/filter-box.js";
import { EmptyState, ErrorBox, LoadingState } from "../../ui/states.js";
import { EmptyRelation, InspectorSection, RelationLink } from "../shared/inspector.js";
import { useCloseTo } from "../shared/origin.js";
import { stripEphemeral, useOverlayViewState } from "../shared/overlay-state.js";
import { CardGrid, ResourceCard } from "../shared/resource-card.js";
import { ResourceHome } from "../shared/resource-home.js";
import { ResourceOverlay } from "../shared/resource-overlay.js";
import { ResourceTable, TitleCell } from "../shared/resource-table.js";
import { useOperations } from "../../lib/runtime-context.js";
import { useUrlFilters } from "../shared/use-url-filters.js";
import { ModeBadge } from "../plans/parts.js";

/* Environments — where Plans run: a named context with its values (workspaceRoot, URLs…) and its
   credentials. The interface edits values and credential *references*: a credential value is sent once
   to the runtime (`credential.save`) and never read back — the runtime only ever lists names. */

interface Filters { q: string; view: "cards" | "list"; sort: "name" | "usage"; group: "none" }
const readFilters = (params: URLSearchParams): Filters => ({ q: params.get("q") ?? "", view: params.get("view") === "list" ? "list" : "cards", sort: params.get("sort") === "usage" ? "usage" : "name", group: "none" });
const writeFilters = (filters: Filters, base: URLSearchParams): URLSearchParams => {
  const next = new URLSearchParams(base);
  filters.q ? next.set("q", filters.q) : next.delete("q");
  filters.view === "list" ? next.set("view", "list") : next.delete("view");
  filters.sort === "usage" ? next.set("sort", "usage") : next.delete("sort");
  return next;
};

interface EnvironmentRow { entry: EnvironmentEntry; id: string; values: Array<[string, string]>; plans: number; dryRuns: number; runnable: number; credentials: number }

function useEnvironmentRows(): { rows: EnvironmentRow[]; loading: boolean; error: string | undefined } {
  const environments = useEnvironments();
  const plans = usePlans();
  const runnable = useOperationEnvironments();
  const credentials = useCredentials();
  const rows = useMemo<EnvironmentRow[]>(() => (environments.data ?? []).map((entry) => ({
    entry,
    id: entry.name,
    values: Object.entries(entry.values).map(([key, value]) => [key, String(value)]),
    plans: (plans.data ?? []).filter((plan) => plan.environment === entry.name && plan.mode === "live").length,
    dryRuns: (plans.data ?? []).filter((plan) => plan.environment === entry.name && plan.mode === "dry-run").length,
    runnable: (runnable.data ?? []).filter((operation) => operation.environments.some((candidate) => candidate.name === entry.name && candidate.compatible)).length,
    credentials: (credentials.data ?? []).filter((credential) => credential.environment === entry.name).length,
  })), [environments.data, plans.data, runnable.data, credentials.data]);
  return { rows, loading: environments.isLoading, error: environments.error?.message };
}

export function EnvironmentsHome() {
  const { t } = useTranslation();
  const location = useLocation();
  const [filters, update] = useUrlFilters(readFilters, writeFilters, "environments");
  const { rows, loading, error } = useEnvironmentRows();
  const current = useCurrentEnvironment();
  const overlayOpen = location.pathname !== "/environments" && location.pathname !== "/environments/";
  const needle = filters.q.trim().toLowerCase();
  const visible = rows.filter((row) => !needle || `${row.id} ${row.values.map(([key, value]) => `${key} ${value}`).join(" ")}`.toLowerCase().includes(needle))
    .sort((a, b) => (filters.sort === "usage" ? (b.plans + b.dryRuns) - (a.plans + a.dryRuns) || a.id.localeCompare(b.id) : a.id.localeCompare(b.id)));
  return (
    <ResourceHome
      crumbs={[{ label: "TRUST", to: "/overview" }, { label: t("environments.home.crumb") }]}
      title={t("environments.home.title")}
      total={rows.length}
      visible={visible.length}
      filterBox={<FilterBox query={filters.q} onQuery={(q) => update({ q })} groups={[]} placeholder={t("environments.home.searchPlaceholder")} onClearAll={() => update({ q: "" })} />}
      display={{ view: filters.view, onView: (view) => update({ view }), group: "none", groupOptions: [{ value: "none", label: t("environments.home.groupNone") }], onGroup: () => undefined, sort: filters.sort, sortOptions: [{ value: "name", label: t("environments.home.sortName") }, { value: "usage", label: t("environments.home.sortUsage") }], onSort: (sort) => update({ sort }) }}
      loading={loading}
      error={error}
      emptyTitle={rows.length ? t("environments.home.emptyTitleNoMatch") : t("environments.home.emptyTitleNone")}
      createTo="/environments/new"
      createLabel={t("environments.home.create")}
      emptyBody={rows.length ? t("environments.home.emptyBodyNoMatch") : undefined}
      onClearFilters={() => update({ q: "" })}
      groups={[{ key: "all", label: "", rows: visible }]}
      renderCards={(list) => (
        <CardGrid>
          {list.map((row) => (
            <ResourceCard key={row.id} to={`/environments/${encodeURIComponent(row.id)}${location.search}`} marks={<>{row.id === current.name ? <Badge tone="success">{t("shell.environment.current")}</Badge> : null}{row.plans ? <Badge tone="info">{plural(row.plans, "plan")}</Badge> : null}{row.dryRuns ? <Badge tone="warning">{plural(row.dryRuns, "dryRun")}</Badge> : null}</>} title={row.id} id={plural(row.values.length, "value")}
              facts={row.values.slice(0, 3).map(([key, value]) => ({ label: key, value: <span className="mono truncate" title={value}>{value}</span> }))}
              footerLeft={<span className="inline-flex items-center gap-1 text-label text-muted"><KeyRound size={12} /> {plural(row.credentials, "credential")}</span>}
              footerRight={<span className="inline-flex items-center gap-1 text-label text-muted"><TerminalSquare size={12} /> {plural(row.runnable, "runnableOperation")}</span>} />
          ))}
        </CardGrid>
      )}
      renderList={(list) => (
        <ResourceTable columns={[{ key: "n", label: t("environments.home.columns.environment"), width: "22%" }, { key: "v", label: t("environments.home.columns.values") }, { key: "u", label: t("environments.home.columns.usedBy"), width: "18%" }, { key: "r", label: t("environments.home.columns.runnable"), width: "12%" }]} rows={list} rowKey={(row) => row.id}
          renderCells={(row) => [
            <TitleCell key="n" to={`/environments/${encodeURIComponent(row.id)}${location.search}`} title={row.id} id={plural(row.values.length, "value")} />,
            <dl key="v" className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 text-body">{row.values.map(([key, value]) => <div key={key} className="contents"><dt className="mono text-muted">{key}</dt><dd className="mono truncate">{value}</dd></div>)}</dl>,
            <span key="u" className="flex items-center gap-1 text-body">{row.plans ? <Badge tone="info">{plural(row.plans, "plan")}</Badge> : null}{row.dryRuns ? <Badge tone="warning">{plural(row.dryRuns, "dryRun")}</Badge> : null}{!row.plans && !row.dryRuns ? <span className="text-faint">—</span> : null}</span>,
            <span key="r" className="text-body text-muted">{plural(row.runnable, "operation")}</span>,
          ]} />
      )}
      overlayOpen={overlayOpen}
    />
  );
}

export function EnvironmentOverlay({ mode = "item" }: { mode?: "item" | "new" }) {
  const { t } = useTranslation();
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const name = mode === "new" ? "" : decodeURIComponent(params.environment ?? "");
  const listSearch = useMemo(() => stripEphemeral(location.search), [location.search]);
  const close = useCloseTo(`/environments${listSearch}`);
  const { rows, loading } = useEnvironmentRows();
  const current = useCurrentEnvironment();
  const plans = usePlans();
  const runnable = useOperationEnvironments();
  const view = useOverlayViewState<"overview">(["overview"], "overview");
  const row = mode === "new" ? undefined : rows.find((candidate) => candidate.id === name);
  const onIt = (plans.data ?? []).filter((plan) => plan.environment === name);
  const operations = (runnable.data ?? []).filter((operation) => operation.environments.some((candidate) => candidate.name === name && candidate.compatible));

  // Draft: the name (new only) and the value rows; `dirty` compares against what the runtime holds.
  const [draftName, setDraftName] = useState("");
  const [values, setValues] = useState<Array<[string, string]>>([]);
  useEffect(() => { setValues(row?.values ?? []); setDraftName(""); }, [row?.entry, mode]);
  const dirty = mode === "new" || JSON.stringify(values) !== JSON.stringify(row?.values ?? []);
  const targetName = mode === "new" ? draftName.trim() : name;
  const nameOk = /^[a-z0-9][a-z0-9-]*$/.test(targetName);
  const valuesOk = values.every(([key, value]) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(key) && value.length > 0) && new Set(values.map(([key]) => key)).size === values.length;
  const save = useSaveEnvironment();
  const remove = useRemoveEnvironment();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const onSave = () => save.mutate({ environment: targetName, values: Object.fromEntries(values) }, {
    onSuccess: () => { if (mode === "new") navigate(`/environments/${encodeURIComponent(targetName)}${listSearch}`, { replace: true }); },
  });
  const onDelete = () => remove.mutate(name, { onSuccess: () => navigate(`/environments${listSearch}`, { replace: true }) });
  const error = mutationError(save.error ?? remove.error);

  return (
    <ResourceOverlay
      onClose={close}
      crumbs={[{ label: "TRUST", to: "/overview" }, { label: t("environments.home.crumb"), to: `/environments${listSearch}` }, { label: mode === "new" ? t("environments.overlay.newTitle") : name, mono: mode !== "new" }]}
      labelledBy="environment-title"
      kicker={t("environments.overlay.kicker")}
      badges={<>{row && current.name === name ? <Badge tone="success">{t("shell.environment.current")}</Badge> : null}<Badge tone="neutral" className="inline-flex items-center gap-1"><Server size={11} /> {mode === "new" ? t("environments.overlay.stateDraft") : dirty ? t("environments.overlay.stateEdited") : t("environments.overlay.stateConfigured")}</Badge></>}
      id={row ? `${plural(row.values.length, "value")} · ${plural(row.credentials, "credential")}` : mode === "new" ? t("environments.overlay.unnamed") : name}
      title={mode === "new" ? (draftName.trim() || t("environments.overlay.newTitle")) : name}
      loading={mode === "item" && loading ? <LoadingState /> : mode === "item" && !row ? <div className="p-8"><EmptyState title={t("environments.overlay.unknown", { name })} action={<Button onClick={close}>{t("common.actions.back")}</Button>} /></div> : undefined}
      actions={
        <>
          {row && current.name !== name ? <Button size="sm" icon={<Server size={13} />} onClick={() => current.select(name)}>{t("shell.environment.useAsCurrent")}</Button> : null}
          {row ? <Button size="sm" icon={<Trash2 size={13} />} disabled={remove.isPending} onClick={() => setConfirmDelete(true)}>{t("common.actions.delete")}</Button> : null}
          <Button size="sm" variant="primary" icon={<Save size={13} />} disabled={!dirty || !nameOk || !valuesOk || save.isPending} onClick={onSave}>{save.isPending ? t("common.actions.saving") : mode === "new" ? t("common.actions.create") : t("common.actions.save")}</Button>
          <ConfirmDialog open={confirmDelete} tone="danger" title={t("environments.overlay.deleteTitle", { name })} body={onIt.length ? t("environments.overlay.deleteBodyReferenced", { plans: plural(onIt.length, "plan") }) : t("environments.overlay.deleteBodyPlain")} confirmLabel={t("common.actions.delete")} busy={remove.isPending} onCancel={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); onDelete(); }} />
        </>
      }
      tabs={[{ value: "overview", label: <>{t("environments.overlay.tabOverview")}</> }]}
      tab={view.tab}
      onTab={view.setTab}
      inspector={row ? (
        <>
          <InspectorSection title={t("environments.overlay.plansOnIt")} count={onIt.length}>
            {onIt.length === 0 ? <EmptyRelation>{t("environments.overlay.noPlan")}</EmptyRelation> : null}
            {onIt.map((plan) => <RelationLink key={plan.plan} to={`/${plan.mode === "dry-run" ? "dry-runs" : "plans"}/${encodeURIComponent(plan.plan)}`} icon={plan.mode === "dry-run" ? <FlaskConical /> : <Activity />} title={plan.plan} meta={`${plan.procedure} · ${plan.satisfiedChecks}/${plan.checkCount}`} state={<ModeBadge mode={plan.mode} />} />)}
          </InspectorSection>
          <InspectorSection title={t("environments.overlay.runnableOperations")} count={operations.length}>
            {operations.map((operation) => <RelationLink key={operation.operation} to={`/operations/${encodeURIComponent(operation.operation)}`} icon={<TerminalSquare />} title={operation.operation} meta={t("environments.overlay.version", { version: operation.version })} />)}
          </InspectorSection>
        </>
      ) : undefined}
    >
      <div className="flex h-full flex-col gap-3 overflow-y-auto bg-bg p-4 [&>*]:shrink-0">
        {error ? <ErrorBox message={error} /> : null}
        {mode === "new" ? (
          <section className="rounded-(--radius-3) border border-border bg-surface p-4">
            <Field label={t("environments.overlay.nameLabel")} hint={t("environments.overlay.nameHint")}>
              <TextInput value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder={t("environments.overlay.namePlaceholder")} className="w-72" aria-invalid={draftName !== "" && !nameOk} autoFocus />
            </Field>
          </section>
        ) : null}
        <section className="rounded-(--radius-3) border border-border bg-surface p-4" data-doc="environment.values">
          <div className="flex items-center justify-between"><span className="kicker">{t("environments.overlay.valuesKicker")}</span><Expert><span className="text-caption text-faint">{t("environments.overlay.valuesHint")}</span></Expert></div>
          <KeyValueEditor rows={values} onChange={setValues} keyPlaceholder={t("environments.overlay.valueKeyPlaceholder")} valuePlaceholder={t("environments.overlay.valueValuePlaceholder")} />
        </section>
        {row ? <CredentialsSection environment={name} /> : (
          <p className="text-body text-muted"><KeyRound size={12} className="mr-1 inline" /> {t("environments.overlay.credentialsLater")}</p>
        )}
        {row ? <OperationCoverage values={values.map(([key]) => key)} /> : null}
      </div>
    </ResourceOverlay>
  );
}

/** Editable name/value rows (add, edit, remove). Validation is the caller's; empty keys are ignored on save. */
function KeyValueEditor({ rows, onChange, keyPlaceholder, valuePlaceholder }: { rows: Array<[string, string]>; onChange: (rows: Array<[string, string]>) => void; keyPlaceholder: string; valuePlaceholder: string }) {
  const { t } = useTranslation();
  const set = (index: number, patch: Partial<{ key: string; value: string }>) => onChange(rows.map((row, at) => (at === index ? [patch.key ?? row[0], patch.value ?? row[1]] : row)));
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {rows.map(([key, value], index) => (
        <div key={index} className="flex items-center gap-2">
          <TextInput value={key} onChange={(event) => set(index, { key: event.target.value })} placeholder={keyPlaceholder} className="mono w-48" aria-label={t("environments.values.nameLabel")} />
          <TextInput value={value} onChange={(event) => set(index, { value: event.target.value })} placeholder={valuePlaceholder} className="mono min-w-0 flex-1" aria-label={t("environments.values.valueLabel")} />
          <IconButton size="sm" label={t("environments.values.remove")} onClick={() => onChange(rows.filter((_row, at) => at !== index))}><X size={13} /></IconButton>
        </div>
      ))}
      {rows.length === 0 ? <p className="text-body text-faint">{t("environments.values.none")}</p> : null}
      <div><Button size="sm" icon={<Plus size={13} />} onClick={() => onChange([...rows, ["", ""]])}>{t("environments.values.add")}</Button></div>
    </div>
  );
}

/** Credential references of one environment: names only. A new value is written once and never shown again. */
function CredentialsSection({ environment }: { environment: string }) {
  const { t } = useTranslation();
  const credentials = useCredentials(environment);
  const save = useSaveCredential();
  const remove = useRemoveCredential();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [removing, setRemoving] = useState<string>();
  const nameOk = /^[a-zA-Z][a-zA-Z0-9]*$/.test(name);
  const error = mutationError(save.error ?? remove.error);
  const submit = () => save.mutate({ environment, name, value }, { onSuccess: () => { setName(""); setValue(""); } });
  return (
    <section className="rounded-(--radius-3) border border-border bg-surface p-4" data-doc="environment.credentials">
      <div className="flex items-center justify-between"><span className="kicker">{t("environments.credentials.kicker")}</span><Expert><span className="text-caption text-faint"><KeyRound size={11} className="mr-1 inline" /> {t("environments.credentials.hint")}</span></Expert></div>
      <ul className="mt-2 flex flex-col gap-1">
        {(credentials.data ?? []).map((credential) => (
          <li key={credential.name} className="flex items-center gap-2 text-body-lg">
            <span className="mono w-48 truncate">{credential.name}</span>
            <span className="mono flex-1 text-faint" aria-label={t("environments.credentials.heldByRuntime")}>••••••••</span>
            <IconButton size="sm" label={t("environments.credentials.remove", { name: credential.name })} disabled={remove.isPending} onClick={() => setRemoving(credential.name)}><X size={13} /></IconButton>
          </li>
        ))}
        {credentials.isSuccess && credentials.data.length === 0 ? <li className="text-body text-faint">{t("environments.credentials.none")}</li> : null}
      </ul>
      <form className="mt-2 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (nameOk && value) submit(); }}>
        <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder={t("environments.credentials.namePlaceholder")} className="mono w-48" aria-label={t("environments.credentials.nameLabel")} autoComplete="off" />
        <TextInput type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder={t("environments.credentials.valuePlaceholder")} className="mono min-w-0 flex-1" aria-label={t("environments.credentials.valueLabel")} autoComplete="new-password" />
        <Button size="sm" type="submit" icon={<Plus size={13} />} disabled={!nameOk || !value || save.isPending}>{save.isPending ? t("common.actions.saving") : t("environments.credentials.add")}</Button>
      </form>
      {error ? <p className="mt-2 text-body text-danger">{error}</p> : null}
      <ConfirmDialog open={removing !== undefined} tone="danger" title={t("environments.credentials.removeTitle", { name: removing ?? "" })} body={t("environments.credentials.removeBody")} confirmLabel={t("common.actions.remove")} busy={remove.isPending} onCancel={() => setRemoving(undefined)} onConfirm={() => { const target = removing!; setRemoving(undefined); remove.mutate({ environment, name: target }); }} />
    </section>
  );
}

/** Every catalog operation against this environment: runnable or not, and which required values it lacks.
    Computed from the compiled environment schema and the draft value names, so it answers while editing. */
function OperationCoverage({ values }: { values: string[] }) {
  const { t } = useTranslation();
  const operations = useOperations();
  const rows = (operations.data ?? []).map((operation) => {
    const required = Object.keys((operation.environment as { properties?: Record<string, unknown> }).properties ?? {});
    const missing = required.filter((name) => !values.includes(name));
    return { operation, required, missing };
  }).sort((a, b) => Number(a.missing.length > 0) - Number(b.missing.length > 0) || a.operation.operation.localeCompare(b.operation.operation));
  const ok = rows.filter((row) => row.missing.length === 0).length;
  return (
    <section className="rounded-(--radius-3) border border-border bg-surface" data-doc="environment.coverage">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="kicker">{t("environments.coverage.kicker")}</span>
        <span className="text-caption text-faint">{t("environments.coverage.summary", { ok: String(ok), total: String(rows.length) })}</span>
      </div>
      <ResourceTable
        stickyHeader={false}
        columns={[{ key: "ok", label: "", width: "40px" }, { key: "op", label: t("environments.coverage.columnOperation"), width: "34%" }, { key: "needs", label: t("environments.coverage.columnNeeds") }]}
        rows={rows}
        rowKey={(row) => row.operation.operation}
        renderCells={(row) => [
          <span key="ok" className={cx("inline-flex h-5 w-5 items-center justify-center rounded-full", row.missing.length === 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger")} title={row.missing.length === 0 ? t("environments.coverage.runnableHere") : t("environments.coverage.missing", { names: row.missing.join(", ") })}>
            {row.missing.length === 0 ? <Check size={12} /> : <X size={12} />}
          </span>,
          <TitleCell key="op" to={`/operations/${encodeURIComponent(row.operation.operation)}`} title={row.operation.operation} id={row.operation.title} />,
          <span key="needs" className="flex flex-wrap gap-1">
            {row.required.length === 0 ? <span className="text-body text-faint">{t("environments.coverage.nothing")}</span> : null}
            {row.required.map((name) => (
              <span key={name} className={cx("mono rounded-(--radius-1) border px-1.5 py-0.5 text-caption", row.missing.includes(name) ? "border-danger/40 bg-danger-soft text-danger" : "border-border bg-surface-2 text-muted")}>{name}</span>
            ))}
          </span>,
        ]}
      />
    </section>
  );
}
