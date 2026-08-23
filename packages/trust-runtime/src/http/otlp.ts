import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";

import {
  PlanRuntimeError,
  type FactBatchInput,
  type PlanRuntime,
} from "../plan/runtime.js";

export const OTLP_JSON_LIMIT_BYTES = 1_048_576;

export interface OtlpHttpDependencies {
  readonly planRuntime: PlanRuntime;
}

export class InvalidFactTrace extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFactTrace";
  }
}

export function createOtlpHttpHandler(dependencies: OtlpHttpDependencies): Router {
  const router = express.Router();
  const handle: RequestHandler = async (request, response) => {
    try {
      await dependencies.planRuntime.ingestLiveFacts(parseCheckFactTrace(request.body));
      response.status(200).json({});
    } catch (error) {
      if (error instanceof PlanRuntimeError && error.code === "fact-batch-rejected") {
        response.status(200).json({
          partialSuccess: {
            rejectedSpans: 1,
            errorMessage: error.code,
          },
        });
        return;
      }
      if (error instanceof InvalidFactTrace || error instanceof PlanRuntimeError) {
        response.status(400).json({
          partialSuccess: {
            rejectedSpans: 1,
            errorMessage: error instanceof PlanRuntimeError ? error.code : error.message,
          },
        });
        return;
      }
      response.status(500).json({
        partialSuccess: { rejectedSpans: 1, errorMessage: "internal-error" },
      });
    }
  };

  router.post(
    "/",
    express.json({
      limit: OTLP_JSON_LIMIT_BYTES,
      strict: true,
      type: ["application/json", "application/*+json"],
    }),
    handle,
  );
  router.use(bodyParserFailure);
  return router;
}

function parseCheckFactTrace(value: unknown): FactBatchInput {
  const root = record(value, "OTLP request");
  const resourceSpans = singleArray(root.resourceSpans, "resourceSpans");
  const resourceSpan = record(resourceSpans[0], "resourceSpans[0]");
  const scopeSpans = singleArray(resourceSpan.scopeSpans, "scopeSpans");
  const scopeSpan = record(scopeSpans[0], "scopeSpans[0]");
  const spans = singleArray(scopeSpan.spans, "spans");
  const span = record(spans[0], "spans[0]");
  if (span.name !== "trust.runner.facts") {
    throw new InvalidFactTrace("OTLP span is not a TRUST runner Fact batch");
  }
  const spanAttributes = attributes(span.attributes, "span attributes");
  return {
    attemptKey: requiredAttribute(spanAttributes, "trust.attempt_key"),
    attemptHandle: requiredAttribute(spanAttributes, "trust.attempt_handle"),
    executionId: requiredAttribute(spanAttributes, "trust.execution_id"),
    checkUri: requiredAttribute(spanAttributes, "trust.check_uri"),
    facts: parseFactEvents(span.events, "trust.runner.fact"),
    recordedAt: unixNanoInstant(span.startTimeUnixNano),
  };
}

function parseFactEvents(
  value: unknown,
  eventName: "trust.runner.fact",
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    throw new InvalidFactTrace("OTLP Fact batch events must be an array");
  }
  const indexed = value.map((candidate) => {
    const event = record(candidate, "Fact event");
    if (event.name !== eventName) {
      throw new InvalidFactTrace("OTLP event is not a TRUST Fact");
    }
    const values = otlpAttributeValues(event.attributes, "Fact event attributes");
    const index = values.get("trust.fact.index");
    const fact: Record<string, unknown> = {};
    for (const [key, item] of values) {
      if (key === "trust.fact.index") continue;
      if (!key.startsWith("trust.fact.")) {
        throw new InvalidFactTrace(`Fact event attribute ${key} is invalid`);
      }
      const attributeName = key.slice("trust.fact.".length);
      const field = attributeName === "observed_at" ? "observedAt" : attributeName;
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field) || Object.hasOwn(fact, field)) {
        throw new InvalidFactTrace(`Fact event attribute ${key} is invalid or repeated`);
      }
      fact[field] = item;
    }
    if (
      !Number.isSafeInteger(index)
      || (index as number) < 0
      || typeof fact.kind !== "string"
      || fact.kind.length === 0
      || typeof fact.observedAt !== "string"
      || fact.observedAt.length === 0
      || !isRecord(fact.values)
    ) {
      throw new InvalidFactTrace("Fact event attributes are invalid");
    }
    return { index: index as number, fact };
  }).sort((left, right) => left.index - right.index);
  if (indexed.some((entry, index) => entry.index !== index)) {
    throw new InvalidFactTrace("Fact event indexes must be contiguous from zero");
  }
  return indexed.map((entry) => entry.fact);
}

function attributes(value: unknown, label: string): ReadonlyMap<string, string> {
  const values = otlpAttributeValues(value, label);
  const strings = new Map<string, string>();
  for (const [key, item] of values) {
    if (typeof item === "string") strings.set(key, item);
  }
  return strings;
}

type OtlpAttributeValue =
  | string
  | number
  | boolean
  | readonly OtlpAttributeValue[]
  | { readonly [key: string]: OtlpAttributeValue };

function otlpAttributeValues(
  value: unknown,
  label: string,
): ReadonlyMap<string, OtlpAttributeValue> {
  if (!Array.isArray(value)) throw new InvalidFactTrace(`${label} must be an array`);
  const result = new Map<string, OtlpAttributeValue>();
  for (const candidate of value) {
    const attribute = record(candidate, label);
    const key = attribute.key;
    const wrapped = record(attribute.value, `${label} value`);
    if (typeof key !== "string" || result.has(key)) {
      throw new InvalidFactTrace(`${label} contains an invalid or duplicate key`);
    }
    result.set(key, otlpValue(wrapped, `${label} ${key}`));
  }
  return result;
}

function otlpValue(value: Record<string, unknown>, label: string): OtlpAttributeValue {
  const variants = [
    "stringValue",
    "intValue",
    "doubleValue",
    "boolValue",
    "arrayValue",
    "kvlistValue",
  ].filter((name) => Object.hasOwn(value, name));
  if (variants.length !== 1) {
    throw new InvalidFactTrace(`${label} contains an unsupported value`);
  }
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.intValue === "string" && /^-?\d+$/.test(value.intValue)) {
    const integer = Number(value.intValue);
    if (Number.isSafeInteger(integer)) return integer;
  }
  if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) {
    return value.doubleValue;
  }
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (value.arrayValue !== undefined) {
    const array = record(value.arrayValue, `${label} arrayValue`);
    if (!Array.isArray(array.values)) {
      throw new InvalidFactTrace(`${label} arrayValue values must be an array`);
    }
    return array.values.map((item) => otlpValue(record(item, `${label} array item`), label));
  }
  if (value.kvlistValue !== undefined) {
    const list = record(value.kvlistValue, `${label} kvlistValue`);
    if (!Array.isArray(list.values)) {
      throw new InvalidFactTrace(`${label} kvlistValue values must be an array`);
    }
    const result = new Map<string, OtlpAttributeValue>();
    for (const item of list.values) {
      const pair = record(item, `${label} kvlist item`);
      if (typeof pair.key !== "string" || result.has(pair.key)) {
        throw new InvalidFactTrace(`${label} kvlistValue contains an invalid or duplicate key`);
      }
      result.set(pair.key, otlpValue(record(pair.value, `${label} ${pair.key}`), label));
    }
    return Object.fromEntries(result);
  }
  throw new InvalidFactTrace(`${label} contains an unsupported value`);
}

function requiredAttribute(attributes: ReadonlyMap<string, string>, key: string): string {
  const value = attributes.get(key);
  if (value === undefined || value.length === 0) {
    throw new InvalidFactTrace(`OTLP attribute ${key} is required`);
  }
  return value;
}

function unixNanoInstant(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new InvalidFactTrace("OTLP startTimeUnixNano is invalid");
  }
  const milliseconds = BigInt(value) / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidFactTrace("OTLP startTimeUnixNano exceeds the supported range");
  }
  const instant = new Date(Number(milliseconds));
  if (!Number.isFinite(instant.getTime())) {
    throw new InvalidFactTrace("OTLP startTimeUnixNano is not a valid instant");
  }
  return instant.toISOString();
}

function singleArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new InvalidFactTrace(`${label} must contain exactly one item`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidFactTrace(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const bodyParserFailure: ErrorRequestHandler = (error, _request, response, next) => {
  if (!isRecord(error)) {
    next(error);
    return;
  }
  const tooLarge = error.type === "entity.too.large";
  response.status(tooLarge ? 413 : 400).json({
    partialSuccess: {
      rejectedSpans: 1,
      errorMessage: tooLarge ? "payload-too-large" : "invalid-json",
    },
  });
};
