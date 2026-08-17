import { CheckCircle2, Play, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { cx, plural } from "../../lib/format.js";
import type { CompiledProcedure } from "../../types.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/states.js";
import { orderedScenarios } from "./model.js";
import { useOrigin } from "../shared/origin.js";

/** Walk the scenario graph: a scenario becomes actionable once every prerequisite is complete. No Plan, no Fact. */
export function ProcedureSimulation({ compiled, error }: { compiled: CompiledProcedure | undefined; error?: string | undefined }) {
  const origin = useOrigin();
  const { t } = useTranslation();
  const [complete, setComplete] = useState<string[]>([]);
  useEffect(() => setComplete([]), [compiled?.definitionDigest]);
  if (!compiled) {
    return <div className="p-6"><EmptyState icon={<Play />} title={t("procedures.simulation.emptyTitle")} body={error ?? t("procedures.simulation.emptyBody")} /></div>;
  }
  const scenarios = orderedScenarios(compiled);
  const actionable = scenarios.filter((scenario) => !complete.includes(scenario.slug) && scenario.dependencies.every((dependency) => complete.includes(dependency)));
  const advance = (slug?: string) => {
    const next = slug ? scenarios.find((scenario) => scenario.slug === slug) : actionable[0];
    if (next) setComplete((current) => [...current, next.slug]);
  };
  const done = complete.length === scenarios.length;

  return (
    <div className="grid h-full min-h-0 grid-cols-[320px_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-border bg-bg p-3 [&>*]:shrink-0">
        <div>
          <strong className="block text-body-lg font-semibold">{t("procedures.simulation.heading")}</strong>
          <p className="mt-1 text-label leading-snug text-muted">{t("procedures.simulation.intro")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" icon={<Play size={13} />} onClick={() => advance()} disabled={done || actionable.length === 0}>{done ? t("procedures.simulation.complete") : actionable[0] ? t("procedures.simulation.advanceTo", { title: actionable[0].title }) : t("procedures.simulation.advance")}</Button>
          <Button icon={<RotateCcw size={12} />} onClick={() => setComplete([])} disabled={complete.length === 0}>{t("procedures.simulation.reset")}</Button>
        </div>
        <p className="text-label text-muted">{t("procedures.simulation.progress", { complete: String(complete.length), total: String(scenarios.length), actionable: String(actionable.length) })}</p>
        <div className="h-1 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${scenarios.length ? (complete.length / scenarios.length) * 100 : 0}%` }} /></div>
      </section>
      <section className="flex min-h-0 flex-col gap-2 overflow-y-auto bg-bg p-3 [&>*]:shrink-0">
        {scenarios.map((scenario, index) => {
          const isComplete = complete.includes(scenario.slug);
          const isActionable = actionable.some((entry) => entry.slug === scenario.slug);
          const checks = compiled.checks.filter((check) => check.scenario === scenario.slug);
          return (
            <div key={scenario.slug} className={cx("rounded-(--radius-2) border bg-surface p-3", isComplete ? "border-success/40" : isActionable ? "border-accent/50" : "border-border opacity-70")}>
              <div className="flex items-center gap-2">
                <span className={cx("inline-flex h-5 w-5 items-center justify-center rounded-full text-caption", isComplete ? "bg-success text-accent-contrast" : isActionable ? "bg-accent text-accent-contrast" : "bg-surface-3 text-muted")}>{isComplete ? <CheckCircle2 size={13} /> : index + 1}</span>
                <span className="text-ui font-medium">{scenario.title}</span>
                <span className="ml-auto text-caption text-muted">{isComplete ? t("procedures.simulation.stateComplete") : isActionable ? t("procedures.simulation.stateActionable") : t("procedures.simulation.waitsFor", { list: scenario.dependencies.filter((dependency) => !complete.includes(dependency)).join(", ") })}</span>
                {isActionable ? <Button size="sm" onClick={() => advance(scenario.slug)}>{t("procedures.simulation.complete")}</Button> : null}
              </div>
              <ul className="mt-2 flex flex-col gap-0.5 pl-7 text-body">
                {checks.map((check) => (
                  <li key={check.name} className="text-muted">
                    <span className="mono text-text">{check.name}</span> · <Link state={origin} to={`/operations/${encodeURIComponent(check.operation)}`} className="mono text-accent hover:underline">{check.operation}</Link>
                    {check.successReason ? <span> — “{check.successReason}”</span> : null}
                  </li>
                ))}
                {checks.length === 0 ? <li className="text-faint">{plural(0, "check")}</li> : null}
              </ul>
            </div>
          );
        })}
      </section>
    </div>
  );
}
