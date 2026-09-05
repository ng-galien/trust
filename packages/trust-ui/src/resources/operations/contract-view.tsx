import type { CompiledOperation, OperationStep } from "@trust/operation";
import { operationLanguage } from "@trust/operation/language";
import { matchOperationStep, matchShellArgument } from "@trust/operation/match";
import { Braces } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../ui/badge.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { EmptyState } from "../../ui/states.js";
import {
  describeAcceptedStatuses,
  describeHttpBody,
  describeHttpLocation,
  describeHttpValue,
} from "./http-view-model.js";
import { stepTypeLabel } from "./model.js";

/** Exact compiled contract handed to the runner. */
export function ContractView({
  compiled,
  error,
}: {
  compiled: CompiledOperation | undefined;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  if (!compiled) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Braces />}
          title={t("operations.contract.emptyTitle")}
          body={error ?? t("operations.contract.emptyBody")}
        />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2 text-body text-muted">
        <span className="mono">{compiled.operation}</span> ·{" "}
        {t("operations.contract.version", { version: compiled.version })} ·{" "}
        <span className="mono">{compiled.contract}</span>
      </div>
      <div className="min-h-0 flex-1">
        <JsonViewer value={compiled} />
      </div>
    </div>
  );
}

export function StepCard({ step, index }: { step: OperationStep; index: number }) {
  return (
    <div className="rounded-(--radius-2) border border-border bg-surface-2 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-caption text-faint">{index + 1}</span>
        <span className="mono text-body-lg font-semibold">{step.name}</span>
        <Badge>{stepTypeLabel(step.type)}</Badge>
        <span className="ml-auto text-caption text-faint">{resultShape(step.type)}</span>
      </div>
      <StepBody step={step} />
    </div>
  );
}

function resultShape(type: OperationStep["type"]) {
  return `→ ${operationLanguage.stepResults[type].join(", ")}`;
}

function StepBody({ step }: { step: OperationStep }) {
  const { t } = useTranslation();
  return matchOperationStep<ReactNode>(step, {
    shell: (step) => {
      const shell = step.shell;
      return (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
          <Term>{t("operations.contract.command")}</Term>
          <dd className="mono">
            {shell.executable}
            {shell.arguments
              .map(
                (argument) =>
                  ` ${matchShellArgument(argument, {
                    literal: (value) => value.value,
                    input: (value) => `${value.prefix ?? ""}{input.${value.input}}`,
                    execution: (value) => `${value.prefix ?? ""}{execution.${value.field}}`,
                  })}`,
              )
              .join("")}
          </dd>
          {shell.cwd ? (
            <>
              <Term>{t("operations.contract.workingDirectory")}</Term>
              <dd className="mono">environment.{shell.cwd.environment}</dd>
            </>
          ) : null}
          <Term>{t("operations.contract.acceptedExits")}</Term>
          <dd>
            {(shell.acceptedExits ?? [{ code: 0 }]).map((exit) => (
              <span key={JSON.stringify(exit)} className="mr-2 inline-flex items-center gap-1">
                <Badge>{t("operations.contract.exit", { code: String(exit.code) })}</Badge>
                {exit.stdoutContains ? (
                  <span className="text-muted">
                    {t("operations.contract.stdoutContains", { text: exit.stdoutContains })}
                  </span>
                ) : null}
                {exit.stderrContains ? (
                  <span className="text-muted">
                    {t("operations.contract.stderrContains", { text: exit.stderrContains })}
                  </span>
                ) : null}
              </span>
            ))}
          </dd>
        </dl>
      );
    },
    http: (step) => {
      const http = step.http;
      const body = describeHttpBody(http);
      return (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
          <Term>{t("operations.contract.request")}</Term>
          <dd className="mono">
            {http.method} {describeHttpLocation(http)}
          </dd>
          {http.headers.length ? (
            <>
              <Term>{t("operations.contract.headers")}</Term>
              <dd className="mono">
                {http.headers.map((header) => `${header.name}=${describeHttpValue(header.source)}`).join(", ")}
              </dd>
            </>
          ) : null}
          {body ? (
            <>
              <Term>{t("operations.contract.body")}</Term>
              <dd className="mono whitespace-pre-wrap">{body}</dd>
            </>
          ) : null}
          <Term>{t("operations.contract.acceptedStatuses")}</Term>
          <dd className="mono">{describeAcceptedStatuses(http)}</dd>
          <Term>{t("operations.contract.reads")}</Term>
          <dd className="uppercase">{http.format}</dd>
        </dl>
      );
    },
    postgresql: (step) => {
      return (
        <div className="flex flex-col gap-2 text-body">
          <code>environment.{step.postgresql.connection.environment}</code>
          <pre className="overflow-x-auto whitespace-pre-wrap">{step.postgresql.statement}</pre>
        </div>
      );
    },
    "file-read": (step) => {
      const file = step.file;
      return (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
          <Term>{t("operations.contract.path")}</Term>
          <dd className="mono">
            environment.{file.root.environment}/{file.relativePath}
          </dd>
          <Term>{t("operations.contract.reads")}</Term>
          <dd className="uppercase">{file.format}</dd>
        </dl>
      );
    },
  });
}

function Term({ children }: { children: ReactNode }) {
  return <dt className="text-muted">{children}</dt>;
}
