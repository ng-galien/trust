import { Activity, ArrowRight, TerminalSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { plural } from "../../lib/format.js";
import type { CompiledProcedure, PlanSummary } from "../../types.js";
import { Badge } from "../../ui/badge.js";
import { Disclosure } from "../../ui/schema.js";
import { EmptyState } from "../../ui/states.js";
import { describeExpectation, orderedScenarios } from "./model.js";
import { useOrigin } from "../shared/origin.js";
import { Description } from "../../ui/description.js";

/** Plain-language reading of a procedure: needs → does (scenarios and their Checks) → establishes → executed by. */
export function ProcedureOverview({ compiled, plans, error }: { compiled: CompiledProcedure | undefined; plans: PlanSummary[]; error?: string | undefined }) {
  const origin = useOrigin();
  const { t } = useTranslation();
  if (!compiled) {
    return <div className="p-6"><EmptyState title={t("procedures.overview.emptyTitle")} body={error ?? t("procedures.overview.emptyBody")} /></div>;
  }
  const inputs = compiled.roles.filter((role) => (role.source as { kind?: string }).kind === "plan-input");
  const scenarios = orderedScenarios(compiled);
  const checksOf = (slug: string) => compiled.checks.filter((check) => check.scenario === slug);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-bg p-4 [&>*]:shrink-0">
      <section className="rounded-(--radius-3) border border-border bg-surface p-4">
        <h2 className="text-lead font-semibold">{compiled.title}</h2>
        {compiled.description ? <Description text={compiled.description} className="mt-1.5 max-w-3xl text-ui leading-relaxed text-muted" /> : null}
        <div className="mt-3 grid gap-3 md:grid-cols-[max-content_1fr] md:gap-x-6">
          <Term>{t("procedures.overview.needs")}</Term>
          <p className="text-ui leading-relaxed">
            {inputs.length ? <>{t("procedures.overview.planInputs", { count: inputs.length })} {inputs.map((role, index) => <Chip key={role.name} last={index === inputs.length - 1}>{role.name}<span className="text-faint"> ({role.cardinality === "many" ? t("procedures.overview.typeList", { type: role.type }) : role.type})</span></Chip>)}</> : t("procedures.overview.noPlanInput")}.
          </p>
          <Term>{t("procedures.overview.does")}</Term>
          <ol className="flex flex-col gap-2 text-ui leading-relaxed">
            {scenarios.map((scenario, index) => (
              <li key={scenario.slug} className="flex gap-2">
                <span className="w-4 shrink-0 text-right text-faint">{index + 1}.</span>
                <div className="min-w-0">
                  <span className="font-medium">{scenario.title}</span>
                  {scenario.dependencies.length ? <span className="text-muted"> {t("procedures.overview.after", { list: scenario.dependencies.map((dependency) => compiled.scenarios.find((entry) => entry.slug === dependency)?.title ?? dependency).join(", ") })}</span> : null}
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {checksOf(scenario.slug).map((check) => (
                      <li key={check.name} className="text-body-lg">
                        <span className="text-muted">{t("procedures.overview.check")} </span><span className="mono">{check.name}</span>
                        <span className="text-muted"> {t("procedures.overview.runs")} </span>
                        <Link state={origin} to={`/operations/${encodeURIComponent(check.operation)}`} className="mono text-accent hover:underline">{check.operation}</Link>
                        {check.target ? <span className="text-muted"> {t("procedures.overview.on")} <span className="mono text-text">{check.target.role}</span></span> : null}
                        {check.successReason ? <span className="text-muted"> {t("procedures.overview.mustEstablish", { reason: check.successReason })}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
          <Term>{t("procedures.overview.establishes")}</Term>
          <p className="text-ui leading-relaxed">
            {t(compiled.checks.some((check) => check.predicates.length) ? "procedures.overview.verdictsWithPredicates" : "procedures.overview.verdicts", { verdicts: plural(compiled.checks.length, "verdict") })}
          </p>
          <Term>{t("procedures.overview.executedBy")}</Term>
          <div className="text-ui leading-relaxed">
            {plans.length === 0 ? <span className="text-muted">{t("procedures.overview.noPlanYet")}</span> : null}
            {plans.map((plan) => (
              <Link state={origin} key={plan.plan} to={`/plans/${encodeURIComponent(plan.plan)}`} className="mr-3 inline-flex items-center gap-1 text-accent hover:underline">
                <Activity size={12} /> {plan.plan} <span className="text-muted">{plan.satisfiedChecks}/{plan.checkCount}</span> <ArrowRight size={11} />
              </Link>
            ))}
          </div>
        </div>
      </section>

      <Disclosure title={t("procedures.overview.checksTitle", { count: compiled.checks.length })} meta={t("procedures.overview.checksMeta")} defaultOpen={false}>
        <div className="flex flex-col gap-2">
          {compiled.checks.map((check) => (
            <div key={check.name} className="rounded-(--radius-2) border border-border bg-surface-2 p-3 text-body">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="mono font-semibold">{check.name}</span>
                <Badge>{compiled.scenarios.find((scenario) => scenario.slug === check.scenario)?.title ?? check.scenario}</Badge>
                <Link state={origin} to={`/operations/${encodeURIComponent(check.operation)}`} className="mono inline-flex items-center gap-1 text-accent hover:underline"><TerminalSquare size={12} /> {check.operation}{check.operationVersion ? <span className="text-faint">@{check.operationVersion}</span> : null}</Link>
              </div>
              {check.inputBindings?.length ? <p className="text-muted">{t("procedures.overview.input")} {check.inputBindings.map((binding) => <span key={binding.input}><span className="mono text-text">{binding.input}</span> {t("procedures.overview.fromRole")} <span className="mono text-text">{binding.role}</span>{binding.selection !== "one" ? ` (${binding.selection})` : ""} </span>)}</p> : null}
              {check.predicates.length ? (
                <table className="mt-1 w-full border-collapse">
                  <thead><tr className="text-left text-meta uppercase tracking-[0.06em] text-faint"><th className="py-0.5 pr-3 font-semibold">{t("procedures.overview.columns.field")}</th><th className="py-0.5 pr-3 font-semibold">{t("procedures.overview.columns.relation")}</th><th className="py-0.5 pr-3 font-semibold">{t("procedures.overview.columns.expectation")}</th><th className="py-0.5 font-semibold">{t("procedures.overview.columns.failureReason")}</th></tr></thead>
                  <tbody>
                    {check.predicates.map((predicate, index) => (
                      <tr key={index} className="border-t border-border">
                        <td className="mono py-1 pr-3">{predicate.field}</td>
                        <td className="py-1 pr-3 text-muted">{predicate.relation}</td>
                        <td className="mono py-1 pr-3">{describeExpectation(predicate.expectation)}</td>
                        <td className="py-1 text-muted">{predicate.failureReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {check.materializes?.length ? <p className="mt-1 text-muted">{t("procedures.overview.materializes", { list: check.materializes.map((entry) => `${entry.role} ← ${entry.field}`).join(", ") })}</p> : null}
              {check.successReason ? <p className="mt-1 text-muted">{t("procedures.overview.success", { reason: check.successReason })}</p> : null}
            </div>
          ))}
        </div>
      </Disclosure>
    </div>
  );
}

function Term({ children }: { children: ReactNode }) {
  return <span className="kicker pt-0.5">{children}</span>;
}

function Chip({ children, last }: { children: ReactNode; last: boolean }) {
  return (
    <>
      <code className="rounded-(--radius-1) bg-surface-2 px-1 py-0.5 text-body">{children}</code>
      {last ? "" : ", "}
    </>
  );
}
