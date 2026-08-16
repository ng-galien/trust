import { createHash, randomBytes } from "node:crypto";

import { httpUrl } from "../http/request.js";
import type { JsonObject, JsonValue } from "../lib/json.js";
import type { DiagnosticEvent, DiagnosticsSink } from "./events.js";

/* Diagnostics leave the runner as standard OTLP/JSON:
   - every event is one log record (`/v1/logs`), sent as soon as it happens so a viewer can follow live;
   - each step and the whole operation become spans (`/v1/traces`) once they end.
   The resource carries `trust.trial.id`; TRUST's diagnostic endpoint fans events out and never stores them as Facts. */

export interface OtlpDiagnosticsOptions {
  /** Base URL of the diagnostic OTLP receiver, e.g. http://127.0.0.1:4318/otlp/diagnostics */
  readonly endpoint: string;
  readonly trialId: string;
  readonly authorization?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export class OtlpDiagnosticsSink implements DiagnosticsSink {
  readonly #logsUrl: string;
  readonly #tracesUrl: string;
  readonly #trialId: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #traceId: string;
  readonly #operationSpanId = randomBytes(8).toString("hex");
  readonly #steps = new Map<string, { spanId: string; start: string; kind: string; detail: JsonObject }>();
  #operationStart: string | undefined;
  #operation: { name: string; version: string } | undefined;
  #queue: Promise<void> = Promise.resolve();
  #failures = 0;

  constructor(options: OtlpDiagnosticsOptions) {
    const base = httpUrl(options.endpoint).href.replace(/\/$/, "");
    this.#logsUrl = `${base}/v1/logs`;
    this.#tracesUrl = `${base}/v1/traces`;
    this.#trialId = options.trialId;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#headers = {
      "content-type": "application/json",
      accept: "application/json",
      ...(options.authorization ? { authorization: options.authorization } : {}),
    };
    this.#traceId = createHash("sha256").update(`trial\0${options.trialId}`).digest("hex").slice(0, 32);
  }

  emit(event: DiagnosticEvent): void {
    this.#post(this.#logsUrl, this.#logRecord(event));
    if (event.type === "operation.start") {
      this.#operationStart = event.at;
      this.#operation = { name: event.operation, version: event.version };
    } else if (event.type === "step.start") {
      this.#steps.set(event.step, { spanId: randomBytes(8).toString("hex"), start: event.at, kind: event.kind, detail: event.detail });
    } else if (event.type === "step.end") {
      const step = this.#steps.get(event.step);
      if (step) this.#post(this.#tracesUrl, this.#span(`step ${event.step}`, step.spanId, this.#operationSpanId, step.start, event.at, event.ok, {
        "trust.step.name": event.step,
        "trust.step.kind": step.kind,
        ...flatten("trust.step", step.detail),
        ...flatten("trust.step.outcome", event.outcome),
        ...(event.error ? { "error.message": event.error } : {}),
      }));
    } else if (event.type === "operation.end" && this.#operationStart) {
      this.#post(this.#tracesUrl, this.#span(`operation ${this.#operation?.name ?? ""}`, this.#operationSpanId, undefined, this.#operationStart, event.at, event.ok, {
        ...(this.#operation ? { "trust.operation": this.#operation.name, "trust.operation.version": this.#operation.version } : {}),
        ...(event.error ? { "error.message": event.error } : {}),
      }));
    }
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  get failures(): number {
    return this.#failures;
  }

  #post(url: string, body: JsonObject): void {
    // Sequential so the receiver observes events in order; failures never break the run.
    this.#queue = this.#queue.then(async () => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: this.#headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (!response.ok) this.#failures += 1;
      } catch {
        this.#failures += 1;
      }
    });
  }

  #resource(): JsonObject {
    return { attributes: [attribute("service.name", "trust-runner"), attribute("trust.trial.id", this.#trialId)] };
  }

  #logRecord(event: DiagnosticEvent): JsonObject {
    const { type, at, ...rest } = event;
    return {
      resourceLogs: [{
        resource: this.#resource(),
        scopeLogs: [{
          scope: { name: "@trust/runner/diagnostics" },
          logRecords: [{
            timeUnixNano: nanos(at),
            severityNumber: type === "runner.log" && event.level === "error" ? 17 : type === "runner.log" && event.level === "warn" ? 13 : 9,
            severityText: type === "runner.log" ? event.level.toUpperCase() : "INFO",
            body: { stringValue: JSON.stringify(rest) },
            attributes: [
              attribute("event.name", `trust.trial.${type}`),
              ...("step" in rest && typeof rest.step === "string" ? [attribute("trust.step.name", rest.step)] : []),
              ...("stream" in rest && typeof rest.stream === "string" ? [attribute("trust.log.stream", rest.stream)] : []),
            ],
            traceId: this.#traceId,
            spanId: "step" in rest && typeof rest.step === "string" ? (this.#steps.get(rest.step)?.spanId ?? this.#operationSpanId) : this.#operationSpanId,
          }],
        }],
      }],
    };
  }

  #span(name: string, spanId: string, parentSpanId: string | undefined, start: string, end: string, ok: boolean, attributes: Record<string, JsonValue>): JsonObject {
    return {
      resourceSpans: [{
        resource: this.#resource(),
        scopeSpans: [{
          scope: { name: "@trust/runner/diagnostics" },
          spans: [{
            traceId: this.#traceId,
            spanId,
            ...(parentSpanId ? { parentSpanId } : {}),
            name,
            kind: 1,
            startTimeUnixNano: nanos(start),
            endTimeUnixNano: nanos(end),
            attributes: Object.entries(attributes).map(([key, value]) => attribute(key, value)),
            status: { code: ok ? 1 : 2 },
          }],
        }],
      }],
    };
  }
}

function nanos(iso: string): string {
  return (BigInt(Date.parse(iso)) * 1_000_000n).toString();
}

function attribute(key: string, value: JsonValue): JsonObject {
  return { key, value: anyValue(value) };
}

function anyValue(value: JsonValue): JsonObject {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (value === null) return {};
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  return { kvlistValue: { values: Object.entries(value).map(([key, entry]) => ({ key, value: anyValue(entry) })) } };
}

function flatten(prefix: string, object: JsonObject): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) Object.assign(out, flatten(`${prefix}.${key}`, value));
    else out[`${prefix}.${key}`] = value;
  }
  return out;
}
