import type { CatalogMetadata } from "@trust/extension-sdk";
import type { CompiledOperation, OperationStep } from "@trust/operation";
import { matchHttpFormat, matchOperationStep, matchShellArgument } from "@trust/operation/match";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Description } from "../../ui/description.js";
import { Expert } from "../../ui/expert.js";
import { Disclosure, schemaProperties } from "../../ui/schema.js";
import { EmptyState } from "../../ui/states.js";
import { CatalogMetadataEditor } from "../shared/catalog-metadata-editor.js";
import { StepCard } from "./contract-view.js";
import { describeAcceptedStatuses, describeHttpBodyKind, describeHttpLocation } from "./http-view-model.js";

/** Plain-language reading of an operation: description, then needs → does → produces; step contracts and projection in expert mode. */
export function OverviewView({
  compiled,
  error,
  metadata,
}: {
  compiled: CompiledOperation | undefined;
  error?: string | undefined;
  metadata?: CatalogMetadata | undefined;
}) {
  const { t } = useTranslation();
  if (!compiled) {
    return (
      <div className="p-6">
        <EmptyState title={t("operations.overview.emptyTitle")} body={error ?? t("operations.overview.emptyBody")} />
      </div>
    );
  }
  const inputs = schemaProperties(compiled.input);
  const environment = schemaProperties(compiled.environment);
  const produced = schemaProperties(compiled.produced);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-bg p-4 [&>*]:shrink-0">
      {metadata ? <CatalogMetadataEditor key={`${metadata.name}:${metadata.revision}`} metadata={metadata} /> : null}
      <section className="rounded-(--radius-3) border border-border bg-surface p-4" data-doc="operation.summary">
        {compiled.description ? (
          <Description text={compiled.description} className="mb-3 max-w-3xl text-ui leading-relaxed" />
        ) : null}
        <div className="grid gap-3 md:grid-cols-[max-content_1fr] md:gap-x-6">
          <SummaryTerm>{t("operations.overview.needs")}</SummaryTerm>
          <p className="text-ui leading-relaxed">
            {inputs.length ? (
              <>
                {t("operations.overview.input", { count: inputs.length })}{" "}
                {inputs.map((field, index) => (
                  <Chip key={field.name} last={index === inputs.length - 1}>
                    {field.name}
                  </Chip>
                ))}
              </>
            ) : (
              t("operations.overview.noInput")
            )}
            {environment.length ? (
              <>
                {" "}
                {t("operations.overview.andEnvironment")}{" "}
                {environment.map((field, index) => (
                  <Chip key={field.name} last={index === environment.length - 1}>
                    {field.name}
                  </Chip>
                ))}
              </>
            ) : (
              t("operations.overview.noEnvironment")
            )}
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
            {produced.length
              ? produced.map((field, index) => (
                  <Chip key={field.name} last={index === produced.length - 1}>
                    {field.name}
                  </Chip>
                ))
              : t("operations.overview.noField")}
            {produced.some(({ spec }) => spec.enum) ? (
              <span className="text-muted">
                {" "}
                —{" "}
                {produced
                  .filter(({ spec }) => spec.enum)
                  .map(({ name, spec }) =>
                    t("operations.overview.isOneOf", {
                      name,
                      values: spec.enum!.map((value) => JSON.stringify(value)).join(", "),
                    }),
                  )
                  .join("; ")}
                .
              </span>
            ) : (
              "."
            )}
          </p>
        </div>
      </section>

      {/* Schemas live in the inspector (Interface); here the expert gets each step's contract and the projection. */}
      <Expert>
        <Disclosure title={t("operations.overview.stepsSection")} defaultOpen={false}>
          <div className="flex flex-col gap-2">
            {compiled.steps.map((step, index) => (
              <StepCard key={step.name} step={step} index={index} />
            ))}
          </div>
        </Disclosure>
        <Disclosure title={t("operations.overview.projectionSection")} defaultOpen={false}>
          <pre className="rounded-(--radius-2) border border-border bg-surface-2 p-3 text-body leading-relaxed">
            {compiled.produce.expression}
          </pre>
        </Disclosure>
      </Expert>
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
  return matchOperationStep<ReactNode>(step, {
    shell: (step) => {
      const shell = step.shell;
      const command = [
        shell.executable,
        ...shell.arguments.map((argument) =>
          matchShellArgument(argument, {
            literal: (value) => value.value,
            input: (value) => `${value.prefix ?? ""}<${value.input}>`,
            execution: (value) => `${value.prefix ?? ""}<execution.${value.field}>`,
          }),
        ),
      ].join(" ");
      const exits = shell.acceptedExits?.map((exit) => exit.code) ?? [0];
      return (
        <>
          <Trans
            i18nKey="operations.overview.step.shellRuns"
            values={{ command }}
            components={{ cmd: <code className="rounded-(--radius-1) bg-surface-2 px-1 text-body" /> }}
            shouldUnescape
          />
          {shell.cwd ? (
            <>
              {" "}
              <Trans
                i18nKey="operations.overview.step.shellCwd"
                values={{ environment: shell.cwd.environment }}
                components={{ env: inlineCode }}
              />
            </>
          ) : null}
          {exits.length > 1 ? (
            <span className="text-muted">
              {" "}
              {t("operations.overview.step.shellExits", { exits: exits.join(t("operations.overview.step.exitsOr")) })}
            </span>
          ) : null}
        </>
      );
    },
    http: (step) => {
      const http = step.http;
      const body = describeHttpBodyKind(http);
      return (
        <>
          <Trans
            i18nKey="operations.overview.step.httpRequest"
            values={{
              method: http.method,
              format: matchHttpFormat(http.format, {
                none: () => t("operations.overview.step.formatNone"),
                text: () => t("operations.overview.step.formatText"),
                json: () => t("operations.overview.step.formatJson"),
              }),
              location: describeHttpLocation(http),
            }}
            components={{ location: inlineCode }}
          />
          {body ? <> {t("operations.overview.step.httpBody", { body })}</> : null}
          {http.headers.length ? (
            <> {t("operations.overview.step.httpHeaders", { count: http.headers.length })}</>
          ) : null}
          {http.acceptedStatuses ? (
            <> {t("operations.overview.step.httpStatuses", { statuses: describeAcceptedStatuses(http) })}</>
          ) : null}
        </>
      );
    },
    postgresql: (step) => {
      return (
        <Trans
          i18nKey="operations.overview.step.postgresql"
          values={{ environment: step.postgresql.connection.environment }}
          components={{ env: inlineCode }}
        />
      );
    },
    "file-read": (step) => {
      const file = step.file;
      return (
        <Trans
          i18nKey="operations.overview.step.fileRead"
          values={{ path: file.relativePath, format: file.format, root: file.root.environment }}
          components={{ path: inlineCode, env: inlineCode }}
        />
      );
    },
  });
}
