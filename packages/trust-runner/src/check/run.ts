import type { JsonObject } from "../lib/json.js";

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
}

export function createCheckRunner(options: CheckRunnerOptions) {
  const clock = options.clock ?? (() => new Date());
  const attemptKey = options.attemptKey ?? (() => globalThis.crypto.randomUUID());
  return {
    async run(checkUri: string): Promise<CheckResult> {
      if (!checkUri.startsWith("trust://")) {
        throw new TypeError("Check URI must start with trust://.");
      }
      const attempt = attemptKey();
      const admission = await options.checkClient.admit(attempt, checkUri);
      if (admission.status === "REFUSED") {
        return {
          status: "REFUSED",
          checkUri,
          reasonCode: admission.reasonCode,
          reason: admission.reason,
        };
      }
      if (Date.parse(admission.expiresAt) <= clock().getTime()) {
        throw new Error("Check admission expired before execution.");
      }
      const result = await runOperation(
        admission.operation,
        admission.actionInput,
        admission.environment,
      );
      const observedAt = clock().toISOString();
      await options.facts.export({
        attemptKey: attempt,
        attemptHandle: admission.attemptHandle,
        checkUri,
        facts: [{
          kind: admission.operation.operation,
          observedAt,
          values: result.produced,
        }],
        recordedAt: clock().toISOString(),
      });
      const finalization = await options.checkClient.finalize(admission.attemptHandle);
      return {
        status: "COMPLETED",
        checkUri,
        actionOutcome: result.steps,
        verdict: finalization.verdict,
        reasonCode: finalization.reasonCode,
        reason: finalization.reason,
        checklistDelta: finalization.checklistDelta,
      };
    },
  };
}
