import { useMutation } from "@tanstack/react-query";
import { Play, RotateCcw } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useRuntime } from "../../lib/runtime-context.js";
import { mutationError } from "../../lib/mutations.js";
import { useExpert } from "../../lib/preferences.js";
import type { CompiledOperation, JsonObject, OperationStep } from "../../types.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { SegmentedControl } from "../../ui/controls.js";
import { blankObject, Disclosure, type FieldIssue, JsonField, type ObjectSchema, SchemaForm, schemaProperties, typeLabel } from "../../ui/schema.js";
import { EmptyState, ErrorBox } from "../../ui/states.js";
import { stepTypeLabel } from "./model.js";

interface SimulationValues { input: JsonObject; environment: JsonObject; steps: Record<string, JsonObject> }

/** Simulation form generated from the compiled contract; the JSONata projection runs for real in the runtime. */
export function SimulationView({ source, compiled }: { source: string; compiled: CompiledOperation | undefined }) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const expert = useExpert();
  const skeleton = useMemo(() => simulationSkeleton(compiled), [compiled]);
  const stepSchemas = useMemo(() => new Map((compiled?.steps ?? []).map((step) => [step.name, stepResultSchema(step, t)])), [compiled, t]);
  const [values, setValues] = useState<SimulationValues>(skeleton);
  const [chosenMode, setMode] = useState<"form" | "json">("form");
  // The JSON mode is an expert affordance: leaving expert mode brings the form back.
  const mode = expert ? chosenMode : "form";
  const [issues, setIssues] = useState<Record<string, FieldIssue[]>>({});
  const issueCount = Object.values(issues).reduce((total, list) => total + list.length, 0);
  const validity = useMemo(() => {
    const cache = new Map<string, (valid: boolean, list: FieldIssue[]) => void>();
    return (key: string) => {
      let handler = cache.get(key);
      if (!handler) {
        handler = (_valid, list) => setIssues((current) => (current[key] === list ? current : { ...current, [key]: list }));
        cache.set(key, handler);
      }
      return handler;
    };
  }, []);
  useEffect(() => setValues((current) => mergeSkeleton(skeleton, current)), [skeleton]);

  const simulate = useMutation({
    mutationFn: () => runtime.simulateOperation(source, values.input, values.environment, values.steps as JsonObject),
  });
  const error = mutationError(simulate.error);

  if (!compiled) {
    return <div className="p-6"><EmptyState icon={<Play />} title={t("operations.simulation.emptyTitle")} /></div>;
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col border-r border-border">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <strong className="min-w-0 flex-1 truncate-1 text-body-lg font-semibold">{t("operations.simulation.title")}</strong>
          {expert ? <SegmentedControl ariaLabel={t("operations.simulation.modeLabel")} size="sm" value={mode} onChange={setMode} options={[{ value: "form", label: t("operations.simulation.modeForm") }, { value: "json", label: t("operations.simulation.modeJson") }]} /> : null}
          <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => setValues(skeleton)}>{t("operations.simulation.reset")}</Button>
          <Button data-doc="simulation.run" size="sm" variant="primary" icon={<Play size={13} />} onClick={() => simulate.mutate()} disabled={simulate.isPending || (mode === "form" && issueCount > 0)} title={issueCount ? t("operations.simulation.fieldsToComplete", { count: issueCount }) : undefined}>
            {simulate.isPending ? t("operations.simulation.simulating") : mode === "form" && issueCount ? t("operations.simulation.completeFields", { count: issueCount }) : t("operations.simulation.run")}
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-bg p-4 [&>*]:shrink-0">
          {mode === "json" ? (
            <JsonField id="simulation-json" value={values} onChange={(next) => next && typeof next === "object" ? setValues(mergeSkeleton(skeleton, next as Partial<SimulationValues>)) : undefined} rows={24} />
          ) : (
            <>
              <div data-doc="simulation.input"><Disclosure title={t("operations.simulation.input")} meta={t("operations.simulation.inputMeta", { count: schemaProperties(compiled.input).length })}>
                <SchemaForm idPrefix="sim-input" schema={compiled.input} value={values.input} onChange={(input) => setValues({ ...values, input })} onValidity={validity("input")} empty={t("operations.simulation.inputEmpty")} />
              </Disclosure></div>
              <Disclosure title={t("operations.simulation.environment")} meta={t("operations.simulation.environmentMeta", { count: schemaProperties(compiled.environment).length })}>
                <SchemaForm idPrefix="sim-env" schema={compiled.environment} value={values.environment} onChange={(environment) => setValues({ ...values, environment })} onValidity={validity("environment")} empty={t("operations.simulation.environmentEmpty")} />
              </Disclosure>
              <div data-doc="simulation.steps" className="flex flex-col gap-3">
              {compiled.steps.map((step, index) => (
                <Disclosure
                  key={step.name}
                  title={<span className="inline-flex items-center gap-2"><span className="text-faint">{index + 1}</span><span className="mono">{step.name}</span><Badge>{stepTypeLabel(step.type)}</Badge></span>}
                  meta={t("operations.simulation.stepResult")}
                >
                  <SchemaForm idPrefix={`sim-step-${step.name}`} schema={stepSchemas.get(step.name)} value={values.steps[step.name] ?? {}} onChange={(result) => setValues({ ...values, steps: { ...values.steps, [step.name]: result } })} onValidity={validity(`step:${step.name}`)} />
                </Disclosure>
              ))}
              </div>
            </>
          )}
        </div>
      </section>
      <section className="flex min-h-0 flex-col" data-doc="simulation.result">
        <div className="flex h-11 shrink-0 items-center border-b border-border px-4">
          <strong className="text-body-lg font-semibold">{t("operations.simulation.producedTitle")}</strong>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error ? <ErrorBox message={error} /> : null}
          {!error && simulate.data ? <ProducedTable compiled={compiled} produced={simulate.data.produced} /> : null}
          {!error && !simulate.data ? <p className="text-body text-faint">{t("operations.simulation.noSimulationYet")}</p> : null}
        </div>
      </section>
    </div>
  );
}

export function ProducedTable({ compiled, produced }: { compiled: CompiledOperation; produced: JsonObject }) {
  const { t } = useTranslation();
  const rows = schemaProperties(compiled.produced);
  const extra = Object.keys(produced).filter((key) => !rows.some((row) => row.name === key));
  return (
    <div className="flex flex-col gap-3">
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="text-left text-meta uppercase tracking-[0.06em] text-faint">
            <th className="py-1 pr-3 font-semibold">{t("operations.simulation.columns.field")}</th>
            <th className="py-1 pr-3 font-semibold">{t("operations.simulation.columns.type")}</th>
            <th className="py-1 font-semibold">{t("operations.simulation.columns.value")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ name, spec }) => (
            <tr key={name} className="border-t border-border align-top">
              <td className="mono py-1.5 pr-3 font-medium">{name}</td>
              <td className="py-1.5 pr-3 text-muted">{typeLabel(spec)}</td>
              <td className="mono py-1.5 break-all">{renderValue(produced[name], t)}</td>
            </tr>
          ))}
          {extra.map((name) => (
            <tr key={name} className="border-t border-border align-top text-warning">
              <td className="mono py-1.5 pr-3 font-medium">{name}</td>
              <td className="py-1.5 pr-3">{t("operations.simulation.undeclared")}</td>
              <td className="mono py-1.5 break-all">{renderValue(produced[name], t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="text-body">
        <summary className="cursor-pointer text-muted hover:text-text">{t("operations.simulation.rawJson")}</summary>
        <pre className="mt-2 rounded-(--radius-2) border border-border bg-surface-2 p-3 text-label leading-relaxed">{JSON.stringify(produced, null, 2)}</pre>
      </details>
    </div>
  );
}

function renderValue(value: unknown, t: TFunction) {
  if (value === undefined) return <span className="text-faint">{t("operations.simulation.missing")}</span>;
  if (typeof value === "string") return value === "" ? <span className="text-faint">“”</span> : value;
  return JSON.stringify(value);
}

function stepResultSchema(step: OperationStep, t: TFunction): ObjectSchema {
  if (step.type === "shell") {
    return {
      properties: {
        exitCode: { type: "integer", minimum: 0, maximum: 255 },
        stdout: { type: "string", description: t("operations.simulation.schema.mayBeEmpty") },
        stderr: { type: "string", description: t("operations.simulation.schema.mayBeEmpty") },
      },
      required: ["exitCode"],
    };
  }
  if (step.type === "http") {
    const format = (step.http as { format?: string } | undefined)?.format;
    return {
      properties: {
        status: { type: "integer", minimum: 100, maximum: 599 },
        headers: { type: "object" },
        body: format === "text" ? { type: "string" } : { type: "object" },
      },
      required: ["status"],
    };
  }
  const format = (step.file as { format?: string } | undefined)?.format;
  return {
    properties: {
      relativePath: { type: "string", minLength: 1 },
      content: format === "json" ? { type: "object" } : { type: "string", description: t("operations.simulation.schema.mayBeEmpty") },
    },
    required: ["relativePath"],
  };
}

function simulationSkeleton(compiled: CompiledOperation | undefined): SimulationValues {
  if (!compiled) return { input: {}, environment: {}, steps: {} };
  const blank = (schema: JsonObject) => blankObject(schema);
  const steps = Object.fromEntries(
    compiled.steps.map((step) => {
      const format = (step[step.type === "file-read" ? "file" : step.type] as { format?: string } | undefined)?.format;
      return [
        step.name,
        step.type === "shell"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : step.type === "http"
            ? { status: 200, headers: {}, body: format === "text" ? "" : {} }
            : { relativePath: (step.file as { relativePath?: string } | undefined)?.relativePath ?? "", content: format === "json" ? {} : "" },
      ];
    }),
  );
  return { input: blank(compiled.input), environment: blank(compiled.environment), steps };
}

function mergeSkeleton(skeleton: SimulationValues, current: Partial<SimulationValues>): SimulationValues {
  return {
    input: { ...skeleton.input, ...(current.input ?? {}) },
    environment: { ...skeleton.environment, ...(current.environment ?? {}) },
    steps: Object.fromEntries(Object.keys(skeleton.steps).map((name) => [name, { ...skeleton.steps[name], ...(current.steps?.[name] ?? {}) }])),
  };
}
