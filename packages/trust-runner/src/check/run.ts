import type { JsonObject } from "../lib/json.js";

import { now, nullSink, type DiagnosticsSink } from "../diagnostics/events.js";
import { runOperation } from "../operation/run.js";
import type { FactExporter } from "../telemetry/otlp.js";
import type { CheckClient } from "./client.js";

export type CheckResult =
  | {
      readonly status: "COMPLETED";
      readonly checkUri: string;
      readonly actionOutcome: JsonObject;
      readonly verdict: "VALIDATED" | "NOT_VALIDATED";
      readonly reasonCode: string;
      readonly reason: string;
      readonly checklistDelta: {
        readonly newlySatisfied: readonly string[];
        readonly newlyOpened: readonly string[];
        readonly unchanged: readonly string[];
      };
    }
  | {
      readonly status: "REFUSED";
      readonly checkUri: string;
      readonly reasonCode: string;
      readonly reason: string;
    };

export interface CheckRunnerOptions {
  readonly checkClient: CheckClient;
  readonly facts: FactExporter;
  readonly clock?: () => Date;
  readonly attemptKey?: () => string;
  readonly diagnostics?: DiagnosticsSink;
}

export function createCheckRunner(options: CheckRunnerOptions) {
  const clock = options.clock ?? (() => new Date());
  const attemptKey = options.attemptKey ?? (() => globalThis.crypto.randomUUID());
  const diagnostics = options.diagnostics ?? nullSink;
  return {
    async run(checkUri: string): Promise<CheckResult> {
      const invocation = parseCheckInvocationUri(checkUri);
      const attempt = attemptKey();
      let phase = "admission";
      diagnostics.emit({ type: "runner.log", at: now(), level: "info", text: `Check ${invocation.checkUri}: requesting admission.` });
      try {
        const admission = await options.checkClient.admit(
          attempt,
          invocation.checkUri,
          invocation.intent,
          invocation.nextIntent,
        );
        if (admission.status === "REFUSED") {
          diagnostics.emit({ type: "runner.log", at: now(), level: "warn", text: `Check ${invocation.checkUri}: admission refused (${admission.reasonCode}).` });
          return {
            status: "REFUSED",
            checkUri: invocation.checkUri,
            reasonCode: admission.reasonCode,
            reason: admission.reason,
          };
        }
        if (Date.parse(admission.expiresAt) <= clock().getTime()) {
          throw new Error("Check admission expired before execution.");
        }
        phase = "operation";
        const result = await runOperation(
          admission.operation,
          admission.actionInput,
          admission.environment,
          diagnostics,
          { id: admission.executionId },
        );
        phase = "fact export";
        const observedAt = clock().toISOString();
        await options.facts.export({
          attemptKey: attempt,
          attemptHandle: admission.attemptHandle,
          executionId: admission.executionId,
          checkUri: invocation.checkUri,
          facts: [{
            kind: admission.operation.operation,
            observedAt,
            values: result.produced,
          }],
          recordedAt: clock().toISOString(),
        });
        phase = "finalization";
        const finalization = await options.checkClient.finalize(admission.attemptHandle);
        diagnostics.emit({ type: "runner.log", at: now(), level: "info", text: `Check ${invocation.checkUri}: completed with ${finalization.verdict}.` });
        return {
          status: "COMPLETED",
          checkUri: invocation.checkUri,
          actionOutcome: result.steps,
          verdict: finalization.verdict,
          reasonCode: finalization.reasonCode,
          reason: finalization.reason,
          checklistDelta: finalization.checklistDelta,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        diagnostics.emit({ type: "runner.log", at: now(), level: "error", text: `Check ${invocation.checkUri}: ${phase} failed: ${reason}` });
        throw error;
      }
    },
  };
}

interface CheckInvocation {
  readonly checkUri: string;
  readonly intent?: string;
  readonly nextIntent?: string;
}

export function parseCheckInvocationUri(value: string): CheckInvocation {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new TypeError("Check URI is invalid.");
  }
  if (uri.protocol !== "trust:" || uri.host.length === 0 || uri.hash.length > 0) {
    throw new TypeError("Check URI must be an opaque trust:// URI without a fragment.");
  }
  const keys = [...uri.searchParams.keys()];
  if (keys.some((key) => key !== "intent" && key !== "nextIntent")) {
    throw new TypeError("Check URI query accepts only intent and nextIntent.");
  }
  if (uri.searchParams.getAll("intent").length > 1 || uri.searchParams.getAll("nextIntent").length > 1) {
    throw new TypeError("Check URI query cannot repeat intent or nextIntent.");
  }
  const intent = uri.searchParams.get("intent") ?? undefined;
  const nextIntent = uri.searchParams.get("nextIntent") ?? undefined;
  if (intent === "" || nextIntent === "") {
    throw new TypeError("Intent values cannot be empty.");
  }
  if (intent === "{intent}" || intent === "{nextIntent}"
    || nextIntent === "{intent}" || nextIntent === "{nextIntent}") {
    throw new TypeError("Replace the intent URI template placeholders before running the Check.");
  }
  const semanticUri = `${uri.protocol}//${uri.host}${uri.pathname}`;
  return {
    checkUri: semanticUri,
    ...(intent === undefined ? {} : { intent }),
    ...(nextIntent === undefined ? {} : { nextIntent }),
  };
}
