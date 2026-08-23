import type { JsonObject } from "../lib/json.js";
import type { ShellRunnerConfiguration } from "../shell/run.js";

import { now, nullSink, type DiagnosticsSink } from "../diagnostics/events.js";
import { runOperation } from "../operation/run.js";
import type { FactExporter } from "../telemetry/otlp.js";
import { CheckClientError, type CheckClient, type CheckFinalization } from "./client.js";

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
  readonly shell?: ShellRunnerConfiguration;
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
      let admittedAttemptHandle: string | undefined;
      let actionOutcome: JsonObject | undefined;
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
        admittedAttemptHandle = admission.attemptHandle;
        phase = "operation";
        if (Date.parse(admission.expiresAt) <= clock().getTime()) {
          throw new Error("Check admission expired before execution.");
        }
        const result = await runOperation(
          admission.operation,
          admission.actionInput,
          admission.environment,
          diagnostics,
          { id: admission.executionId },
          options.shell === undefined ? {} : { shell: options.shell },
        );
        actionOutcome = result.steps;
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
        return completed(invocation.checkUri, result.steps, finalization);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        diagnostics.emit({ type: "runner.log", at: now(), level: "error", text: `Check ${invocation.checkUri}: ${phase} failed: ${reason}` });
        if ((phase === "operation" || phase === "fact export") && admittedAttemptHandle !== undefined) {
          try {
            await options.checkClient.interrupt(admittedAttemptHandle);
            diagnostics.emit({ type: "runner.log", at: now(), level: "info", text: `Check ${invocation.checkUri}: interrupted Attempt ${admittedAttemptHandle} before Facts were accepted.` });
          } catch (interruptionError) {
            if (phase === "fact export"
              && interruptionError instanceof CheckClientError
              && interruptionError.reason === "facts-present"
              && actionOutcome !== undefined) {
              diagnostics.emit({ type: "runner.log", at: now(), level: "info", text: `Check ${invocation.checkUri}: Facts were accepted despite the lost export response; finalizing Attempt ${admittedAttemptHandle}.` });
              try {
                const finalization = await options.checkClient.finalize(admittedAttemptHandle);
                diagnostics.emit({ type: "runner.log", at: now(), level: "info", text: `Check ${invocation.checkUri}: completed with ${finalization.verdict}.` });
                return completed(invocation.checkUri, actionOutcome, finalization);
              } catch (finalizationError) {
                const finalizationReason = finalizationError instanceof Error
                  ? finalizationError.message
                  : String(finalizationError);
                diagnostics.emit({ type: "runner.log", at: now(), level: "error", text: `Check ${invocation.checkUri}: recovery finalization failed: ${finalizationReason}` });
                throw finalizationError;
              }
            }
            const interruptionReason = interruptionError instanceof Error
              ? interruptionError.message
              : String(interruptionError);
            diagnostics.emit({ type: "runner.log", at: now(), level: "warn", text: `Check ${invocation.checkUri}: Attempt interruption failed: ${interruptionReason}` });
          }
        }
        throw error;
      }
    },
  };
}

function completed(checkUri: string, actionOutcome: JsonObject, finalization: CheckFinalization): CheckResult {
  return {
    status: "COMPLETED",
    checkUri,
    actionOutcome,
    verdict: finalization.verdict,
    reasonCode: finalization.reasonCode,
    reason: finalization.reason,
    checklistDelta: finalization.checklistDelta,
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
