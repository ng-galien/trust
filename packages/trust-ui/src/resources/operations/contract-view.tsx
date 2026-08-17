import { Braces } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { CompiledOperation, OperationStep } from "../../types.js";
import { Badge } from "../../ui/badge.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { EmptyState } from "../../ui/states.js";
import { stepTypeLabel } from "./model.js";

/** Exact compiled contract handed to the runner. */
export function ContractView({ compiled, error }: { compiled: CompiledOperation | undefined; error?: string | undefined }) {
  const { t } = useTranslation();
  if (!compiled) {
    return <div className="p-6"><EmptyState icon={<Braces />} title={t("operations.contract.emptyTitle")} body={error ?? t("operations.contract.emptyBody")} /></div>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2 text-body text-muted">
        <span className="mono">{compiled.operation}</span> {t("operations.contract.header", { version: compiled.version, contract: compiled.contract })}
      </div>
      <div className="min-h-0 flex-1">
        <JsonViewer value={compiled} />
      </div>
    </div>
  );
}

interface ShellStep {
  executable: string;
  arguments: Array<{ kind: "literal"; value: string } | { kind: "input"; input: string }>;
  cwd?: { environment: string };
  acceptedExits?: Array<{ code: number; stdoutContains?: string; stderrContains?: string }>;
}
interface HttpStep { method: string; url: { environment: string }; appendInput?: string; format?: string; body?: string; response?: string }
interface FileStep { relativePath: string; root: { environment: string }; format: string }

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
  return type === "shell" ? "→ exitCode, stdout, stderr" : type === "http" ? "→ status, headers, body" : "→ relativePath, content";
}

function StepBody({ step }: { step: OperationStep }) {
  const { t } = useTranslation();
  if (step.type === "shell") {
    const shell = step.shell as ShellStep;
    return (
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
        <Term>{t("operations.contract.command")}</Term>
        <dd className="mono">
          {shell.executable}
          {shell.arguments.map((argument, index) =>
            argument.kind === "literal" ? (
              <span key={index}> {argument.value}</span>
            ) : (
              <span key={index} className="ml-1 rounded-(--radius-1) bg-accent-soft px-1 text-accent" title={t("operations.contract.inputHint", { name: argument.input })}>{`{input.${argument.input}}`}</span>
            ),
          )}
        </dd>
        {shell.cwd ? <><Term>{t("operations.contract.workingDirectory")}</Term><dd className="mono">environment.{shell.cwd.environment}</dd></> : null}
        <Term>{t("operations.contract.acceptedExits")}</Term>
        <dd>
          {(shell.acceptedExits ?? [{ code: 0 }]).map((exit, index) => (
            <span key={index} className="mr-2 inline-flex items-center gap-1">
              <Badge>{t("operations.contract.exit", { code: String(exit.code) })}</Badge>
              {exit.stdoutContains ? <span className="text-muted">{t("operations.contract.stdoutContains", { text: exit.stdoutContains })}</span> : null}
              {exit.stderrContains ? <span className="text-muted">{t("operations.contract.stderrContains", { text: exit.stderrContains })}</span> : null}
            </span>
          ))}
        </dd>
      </dl>
    );
  }
  if (step.type === "http") {
    const http = step.http as HttpStep;
    return (
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
        <Term>{t("operations.contract.request")}</Term>
        <dd className="mono">
          {http.method} environment.{http.url.environment}
          {http.appendInput ? <span className="ml-1 rounded-(--radius-1) bg-accent-soft px-1 text-accent">/{`{input.${http.appendInput}}`}</span> : null}
        </dd>
        {http.method === "POST" ? <><Term>{t("operations.contract.body")}</Term><dd>{t("operations.contract.bodyValue")}</dd></> : null}
        <Term>{t("operations.contract.reads")}</Term>
        <dd className="uppercase">{http.format ?? http.response ?? "json"}</dd>
      </dl>
    );
  }
  const file = step.file as FileStep;
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
      <Term>{t("operations.contract.path")}</Term>
      <dd className="mono">environment.{file.root.environment}/{file.relativePath}</dd>
      <Term>{t("operations.contract.reads")}</Term>
      <dd className="uppercase">{file.format}</dd>
    </dl>
  );
}

function Term({ children }: { children: ReactNode }) {
  return <dt className="text-muted">{children}</dt>;
}
