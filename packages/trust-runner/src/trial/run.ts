import type { CompiledOperation } from "@trust/operation";

import { type DiagnosticsSink, now } from "../diagnostics/events.js";
import { OtlpDiagnosticsSink } from "../diagnostics/otlp.js";
import { isJsonObject, type JsonObject } from "../lib/json.js";
import { runOperation } from "../operation/run.js";

/* A trial runs one Operation for real, outside any Plan or Check, and streams diagnostics.
   TRUST starts it with a job on stdin; the outcome goes back on stdout. */

export interface TrialJob {
  readonly contract: "trust.trial-job@1";
  readonly trialId: string;
  readonly operation: CompiledOperation;
  readonly input: JsonObject;
  readonly environment: JsonObject;
  readonly diagnostics: { readonly endpoint: string; readonly authorization?: string };
}

export interface TrialOutcome {
  readonly contract: "trust.trial-outcome@1";
  readonly trialId: string;
  readonly ok: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly steps?: JsonObject;
  readonly produced?: JsonObject;
  readonly error?: string;
  readonly diagnosticsFailures: number;
}

export function parseTrialJob(value: unknown): TrialJob {
  if (!isJsonObject(value) || value.contract !== "trust.trial-job@1") throw new TypeError("Trial job must declare trust.trial-job@1.");
  if (typeof value.trialId !== "string" || value.trialId === "") throw new TypeError("Trial job needs a trialId.");
  if (!isJsonObject(value.operation)) throw new TypeError("Trial job needs a compiled operation.");
  if (!isJsonObject(value.input) || !isJsonObject(value.environment)) throw new TypeError("Trial job needs input and environment objects.");
  if (!isJsonObject(value.diagnostics) || typeof value.diagnostics.endpoint !== "string") throw new TypeError("Trial job needs a diagnostics endpoint.");
  return {
    contract: "trust.trial-job@1",
    trialId: value.trialId,
    operation: value.operation as unknown as CompiledOperation,
    input: value.input,
    environment: value.environment,
    diagnostics: {
      endpoint: value.diagnostics.endpoint,
      ...(typeof value.diagnostics.authorization === "string" ? { authorization: value.diagnostics.authorization } : {}),
    },
  };
}

export async function runTrial(job: TrialJob, sink?: DiagnosticsSink): Promise<TrialOutcome> {
  const diagnostics = sink ?? new OtlpDiagnosticsSink({ endpoint: job.diagnostics.endpoint, trialId: job.trialId, authorization: job.diagnostics.authorization });
  const startedAt = now();
  diagnostics.emit({ type: "runner.log", at: startedAt, level: "info", text: `Trial ${job.trialId}: running ${job.operation.operation}@${job.operation.version} with ${job.operation.steps.length} step(s).` });
  try {
    const result = await runOperation(job.operation, job.input, job.environment, diagnostics);
    await diagnostics.flush();
    return { contract: "trust.trial-outcome@1", trialId: job.trialId, ok: true, startedAt, endedAt: now(), steps: result.steps, produced: result.produced, diagnosticsFailures: failuresOf(diagnostics) };
  } catch (error) {
    await diagnostics.flush();
    return { contract: "trust.trial-outcome@1", trialId: job.trialId, ok: false, startedAt, endedAt: now(), error: error instanceof Error ? error.message : String(error), diagnosticsFailures: failuresOf(diagnostics) };
  }
}

function failuresOf(sink: DiagnosticsSink): number {
  return sink instanceof OtlpDiagnosticsSink ? sink.failures : 0;
}
