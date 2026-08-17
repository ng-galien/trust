import type { TFunction } from "i18next";
import { ArrowRight, GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { CompiledOperation, OperationStep, PublishedProcedure } from "../../types.js";
import { Disclosure, SchemaTable, schemaProperties } from "../../ui/schema.js";
import { EmptyState } from "../../ui/states.js";
import { StepCard } from "./contract-view.js";
import { useOrigin } from "../shared/origin.js";
import { Description } from "../../ui/description.js";

/** Plain-language reading of an operation: needs → does → produces, then the detailed contract. */
export function OverviewView({ compiled, usedBy, error }: { compiled: CompiledOperation | undefined; usedBy: PublishedProcedure[]; error?: string | undefined }) {
  const { t } = useTranslation();
  const origin = useOrigin();
  if (!compiled) {
    return <div className="p-6"><EmptyState title={t("operations.overview.emptyTitle")} body={error ?? t("operations.overview.emptyBody")} /></div>;
  }
  const inputs = schemaProperties(compiled.input);
  const environment = schemaProperties(compiled.environment);
  const produced = schemaProperties(compiled.produced);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-bg p-4 [&>*]:shrink-0">
      <section className="rounded-(--radius-3) border border-border bg-surface p-4">
        <h2 className="text-lead font-semibold">{compiled.title}</h2>
        {compiled.description ? <Description text={compiled.description} className="mt-1.5 max-w-3xl text-ui leading-relaxed text-muted" /> : null}
        <div className="mt-3 grid gap-3 md:grid-cols-[max-content_1fr] md:gap-x-6">
          <SummaryTerm>{t("operations.overview.needs")}</SummaryTerm>
          <p className="text-ui leading-relaxed">
            {inputs.length ? <>{t("operations.overview.input", { count: inputs.length })} {inputs.map((field, index) => <Chip key={field.name} last={index === inputs.length - 1}>{field.name}</Chip>)}</> : t("operations.overview.noInput")}
            {environment.length ? <> {t("operations.overview.andEnvironment")} {environment.map((field, index) => <Chip key={field.name} last={index === environment.length - 1}>{field.name}</Chip>)}</> : t("operations.overview.noEnvironment")}
            .
          </p>
          <SummaryTerm>{t("operations.overview.does")}</SummaryTerm>
          <ol className="flex flex-col gap-1 text-ui leading-relaxed">
            {compiled.steps.map((step, index) => (
              <li key={step.name} className="flex gap-2">
                <span className="w-4 shrink-0 text-right text-faint">{index + 1}.</span>
                <span>{describeStep(step, t)}</span>
              </li>
            ))}
          </ol>
          <SummaryTerm>{t("operations.overview.produces")}</SummaryTerm>
          <p className="text-ui leading-relaxed">
            {produced.length ? produced.map((field, index) => <Chip key={field.name} last={index === produced.length - 1}>{field.name}</Chip>) : t("operations.overview.noField")}
            {produced.some(({ spec }) => spec.enum) ? <span className="text-muted"> — {produced.filter(({ spec }) => spec.enum).map(({ name, spec }) => t("operations.overview.isOneOf", { name, values: spec.enum!.map((value) => JSON.stringify(value)).join(", ") })).join("; ")}.</span> : "."}
          </p>
          <SummaryTerm>{t("operations.overview.usedBy")}</SummaryTerm>
          <div className="text-ui leading-relaxed">
            {usedBy.length === 0 ? <span className="text-muted">{t("operations.overview.noProcedureYet")}</span> : null}
            {usedBy.map(({ procedure }) => (
              <Link state={origin} key={`${procedure.procedure}@${procedure.version}`} to={`/procedures/${encodeURIComponent(procedure.procedure)}`} className="mr-3 inline-flex items-center gap-1 text-accent hover:underline">
                <GitBranch size={12} /> {procedure.title} <span className="text-muted">{t("operations.overview.procedureVersion", { version: procedure.version })}</span> <ArrowRight size={11} />
              </Link>
            ))}
          </div>
        </div>
      </section>

      <Disclosure title={t("operations.overview.inputSection")} meta={t("operations.overview.inputMeta")} defaultOpen={false}>
        <SchemaTable schema={compiled.input} empty={t("operations.overview.inputEmpty")} />
      </Disclosure>
      <Disclosure title={t("operations.overview.environmentSection")} meta={t("operations.overview.environmentMeta")} defaultOpen={false}>
        <SchemaTable schema={compiled.environment} empty={t("operations.overview.environmentEmpty")} />
      </Disclosure>
      <Disclosure title={t("operations.overview.stepsSection", { count: compiled.steps.length })} meta={t("operations.overview.stepsMeta")} defaultOpen={false}>
        <div className="flex flex-col gap-2">
          {compiled.steps.map((step, index) => (
            <StepCard key={step.name} step={step} index={index} />
          ))}
        </div>
      </Disclosure>
      <Disclosure title={t("operations.overview.producedSection")} meta={t("operations.overview.producedMeta")} defaultOpen={false}>
        <SchemaTable schema={compiled.produced} />
        <pre className="mt-3 rounded-(--radius-2) border border-border bg-surface-2 p-3 text-body leading-relaxed">{compiled.produce.expression}</pre>
      </Disclosure>
    </div>
  );
}

function SummaryTerm({ children }: { children: ReactNode }) {
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

const inlineCode = <code className="text-body" />;

function describeStep(step: OperationStep, t: TFunction): ReactNode {
  if (step.type === "shell") {
    const shell = step.shell as { executable: string; arguments: Array<{ kind: "literal"; value: string } | { kind: "input"; input: string }>; cwd?: { environment: string }; acceptedExits?: Array<{ code: number }> };
    const command = [shell.executable, ...shell.arguments.map((argument) => (argument.kind === "literal" ? argument.value : `<${argument.input}>`))].join(" ");
    const exits = shell.acceptedExits?.map((exit) => exit.code) ?? [0];
    return (
      <>
        <Trans i18nKey="operations.overview.step.shellRuns" values={{ command }} components={{ cmd: <code className="rounded-(--radius-1) bg-surface-2 px-1 text-body" /> }} shouldUnescape />
        {shell.cwd ? <> <Trans i18nKey="operations.overview.step.shellCwd" values={{ environment: shell.cwd.environment }} components={{ env: inlineCode }} /></> : null}
        {exits.length > 1 ? <span className="text-muted"> {t("operations.overview.step.shellExits", { exits: exits.join(t("operations.overview.step.exitsOr")) })}</span> : null}
      </>
    );
  }
  if (step.type === "http") {
    const http = step.http as { method: string; url: { environment: string }; appendInput?: string; format?: string };
    return http.method === "POST" ? (
      <Trans i18nKey="operations.overview.step.httpPost" values={{ url: http.url.environment }} components={{ env: inlineCode }} />
    ) : (
      <>
        <Trans i18nKey="operations.overview.step.httpRead" values={{ format: http.format === "text" ? t("operations.overview.step.formatText") : t("operations.overview.step.formatJson"), url: http.url.environment }} components={{ env: inlineCode }} />
        {http.appendInput ? <> <Trans i18nKey="operations.overview.step.httpFor" values={{ input: http.appendInput }} components={{ field: inlineCode }} /></> : null}
      </>
    );
  }
  const file = step.file as { relativePath: string; root: { environment: string }; format: string };
  return (
    <Trans i18nKey="operations.overview.step.fileRead" values={{ path: file.relativePath, format: file.format, root: file.root.environment }} components={{ path: inlineCode, env: inlineCode }} />
  );
}
