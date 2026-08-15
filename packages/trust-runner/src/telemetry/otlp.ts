import { createHash } from "node:crypto";

import { httpUrl, parseHttpJson, requestHttp } from "../http/request.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../lib/json.js";

export type Fact = JsonObject & {
  readonly kind: string;
  readonly observedAt: string;
  readonly values: JsonObject;
};

export interface FactTrace {
  readonly attemptKey: string;
  readonly executionHandle: string;
  readonly checkUri: string;
  readonly facts: readonly Fact[];
  readonly recordedAt: string;
}

export interface FactExporter {
  export(trace: FactTrace): Promise<void>;
}

export class OtlpFactExporter implements FactExporter {
  readonly #endpoint: string;
  readonly #timeoutMs: number;

  constructor(endpoint: string, timeoutMs = 30_000) {
    const parsed = httpUrl(endpoint);
    if (parsed.pathname !== "/v1/traces" || parsed.search !== "" || parsed.hash !== "") {
      throw new TypeError("OTLP endpoint must be an exact /v1/traces URL.");
    }
    this.#endpoint = parsed.href;
    this.#timeoutMs = timeoutMs;
  }

  async export(trace: FactTrace): Promise<void> {
    const response = await requestHttp({
      method: "POST",
      url: this.#endpoint,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(otlp(trace)),
      timeoutMs: this.#timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OTLP export failed with HTTP ${response.status}.`);
    }
    if (response.body === "") return;
    const body = parseHttpJson(response.body);
    if (isJsonObject(body) && isJsonObject(body.partialSuccess)) {
      const rejectedSpans = body.partialSuccess.rejectedSpans;
      if (BigInt(String(rejectedSpans ?? 0)) > 0n) {
        const errorMessage = body.partialSuccess.errorMessage;
        throw new Error(
          `TRUST rejected the Facts${typeof errorMessage === "string"
            ? `: ${errorMessage}`
            : "."}`,
        );
      }
    }
  }
}

function otlp(trace: FactTrace): JsonObject {
  const timeUnixNano = (BigInt(Date.parse(trace.recordedAt)) * 1_000_000n).toString();
  return {
    resourceSpans: [{
      resource: {
        attributes: [attribute("service.name", "trust-runner")],
      },
      scopeSpans: [{
        scope: { name: "@trust/runner" },
        spans: [{
          traceId: digest(`trace\0${trace.executionHandle}`).slice(0, 32),
          spanId: digest(`span\0${trace.executionHandle}`).slice(0, 16),
          name: "trust.runner.facts",
          kind: 3,
          startTimeUnixNano: timeUnixNano,
          endTimeUnixNano: timeUnixNano,
          attributes: [
            attribute("trust.attempt_key", trace.attemptKey),
            attribute("trust.execution_handle", trace.executionHandle),
            attribute("trust.check_uri", trace.checkUri),
          ],
          events: trace.facts.map((fact, index) => ({
            timeUnixNano,
            name: "trust.runner.fact",
            attributes: factAttributes(fact, index),
          })),
          status: { code: 1 },
        }],
      }],
    }],
  };
}

function attribute(key: string, value: string): JsonObject {
  return { key, value: { stringValue: value } };
}

function factAttributes(fact: Fact, index: number): JsonObject[] {
  return [
    { key: "trust.fact.index", value: { intValue: String(index) } },
    ...Object.entries(fact).map(([name, value]) => {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
        throw new TypeError(`Fact field "${name}" is not a valid attribute name.`);
      }
      const attributeName = name === "observedAt" ? "observed_at" : name;
      return { key: `trust.fact.${attributeName}`, value: otlpValue(value) };
    }),
  ];
}

function otlpValue(value: JsonValue): JsonObject {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Fact number must be finite.");
    return Number.isSafeInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(otlpValue) } };
  }
  if (isJsonObject(value)) {
    return {
      kvlistValue: {
        values: Object.entries(value).map(([key, item]) => ({ key, value: otlpValue(item) })),
      },
    };
  }
  throw new TypeError("Fact values cannot contain null.");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
