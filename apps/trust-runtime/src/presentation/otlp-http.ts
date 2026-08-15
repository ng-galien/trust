import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";

import {
  PlanRuntimeError,
  type CheckFactBatchInput,
  type PlanRuntimeService,
  type SkillFactBatchInput,
} from "../application/plan-runtime-service.js";
import { RegistryAuthorityError, type RegistryAuthority } from "../ports/registry-authority.js";

export const OTLP_JSON_LIMIT_BYTES = 1_048_576;

export interface OtlpHttpDependencies {
  readonly planRuntimeService: PlanRuntimeService;
  readonly registryAuthority: RegistryAuthority;
}

export class InvalidSkillFactTrace extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillFactTrace";
  }
}

export function createOtlpHttpHandler(dependencies: OtlpHttpDependencies): Router {
  const router = express.Router();
  const handle: RequestHandler = (request, response) => {
    try {
      const trace = parseFactTrace(request.body);
      if (trace.type === "check") {
        dependencies.planRuntimeService.ingestCheckFacts(trace.batch);
        response.status(200).json({});
        return;
      }
      const batch = trace.batch;
      const authorizationHeader = request.get("authorization");
      const processAuthorizationHeader = request.get("x-trust-process-authorization");
      dependencies.registryAuthority.authorize({
        ...(authorizationHeader === undefined
          ? {}
          : { authorizationHeader }),
        anyRoleOf: ["runtime"],
        assertedIdentity: batch.runtimeIdentity,
      });
      dependencies.registryAuthority.authorize({
        ...(processAuthorizationHeader === undefined
          ? {}
          : { authorizationHeader: processAuthorizationHeader }),
        anyRoleOf: ["runtime-process"],
        assertedIdentity: batch.processIdentity,
      });
      dependencies.planRuntimeService.ingestFacts(batch);
      response.status(200).json({});
    } catch (error) {
      if (error instanceof RegistryAuthorityError) {
        response.status(401).json({
          partialSuccess: { rejectedSpans: 1, errorMessage: error.reason },
        });
        return;
      }
      if (error instanceof PlanRuntimeError && error.code === "fact-batch-rejected") {
        response.status(200).json({
          partialSuccess: {
            rejectedSpans: 1,
            errorMessage: error.code,
          },
        });
        return;
      }
      if (error instanceof InvalidSkillFactTrace || error instanceof PlanRuntimeError) {
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

type ParsedFactTrace =
  | { readonly type: "check"; readonly batch: CheckFactBatchInput }
  | { readonly type: "skill"; readonly batch: SkillFactBatchInput };

function parseFactTrace(value: unknown): ParsedFactTrace {
  return factSpanName(value) === "trust.runner.facts"
    ? { type: "check", batch: parseCheckFactTrace(value) }
    : { type: "skill", batch: parseSkillFactTrace(value) };
}

function factSpanName(value: unknown): unknown {
  const root = record(value, "OTLP request");
  const resourceSpans = singleArray(root.resourceSpans, "resourceSpans");
  const resourceSpan = record(resourceSpans[0], "resourceSpans[0]");
  const scopeSpans = singleArray(resourceSpan.scopeSpans, "scopeSpans");
  const scopeSpan = record(scopeSpans[0], "scopeSpans[0]");
  const spans = singleArray(scopeSpan.spans, "spans");
  return record(spans[0], "spans[0]").name;
}

function parseCheckFactTrace(value: unknown): CheckFactBatchInput {
  const root = record(value, "OTLP request");
  const resourceSpans = singleArray(root.resourceSpans, "resourceSpans");
  const resourceSpan = record(resourceSpans[0], "resourceSpans[0]");
  const scopeSpans = singleArray(resourceSpan.scopeSpans, "scopeSpans");
  const scopeSpan = record(scopeSpans[0], "scopeSpans[0]");
  const spans = singleArray(scopeSpan.spans, "spans");
  const span = record(spans[0], "spans[0]");
  if (span.name !== "trust.runner.facts") {
    throw new InvalidSkillFactTrace("OTLP span is not a TRUST runner Fact batch");
  }
  const spanAttributes = attributes(span.attributes, "span attributes");
  return {
    attemptKey: requiredAttribute(spanAttributes, "trust.attempt_key"),
    executionHandle: requiredAttribute(spanAttributes, "trust.execution_handle"),
    checkUri: requiredAttribute(spanAttributes, "trust.check_uri"),
    facts: parseFactEvents(span.events, "trust.runner.fact"),
    recordedAt: unixNanoInstant(span.startTimeUnixNano),
  };
}

function parseSkillFactTrace(value: unknown): SkillFactBatchInput {
  const root = record(value, "OTLP request");
  const resourceSpans = singleArray(root.resourceSpans, "resourceSpans");
  const resourceSpan = record(resourceSpans[0], "resourceSpans[0]");
  const resource = record(resourceSpan.resource, "resource");
  const resourceAttributes = attributes(resource.attributes, "resource attributes");
  const scopeSpans = singleArray(resourceSpan.scopeSpans, "scopeSpans");
  const scopeSpan = record(scopeSpans[0], "scopeSpans[0]");
  const spans = singleArray(scopeSpan.spans, "spans");
  const span = record(spans[0], "spans[0]");
  if (span.name !== "trust.skill.facts") {
    throw new InvalidSkillFactTrace("OTLP span is not a TRUST Skill Fact batch");
  }
  const spanAttributes = attributes(span.attributes, "span attributes");
  const facts = parseFactEvents(span.events, "trust.skill.fact");
  return {
    attemptKey: requiredAttribute(spanAttributes, "trust.attempt_key"),
    executionHandle: requiredAttribute(spanAttributes, "trust.execution_handle"),
    checkUri: requiredAttribute(spanAttributes, "trust.check_uri"),
    releaseDigest: requiredAttribute(resourceAttributes, "trust.skill.release_digest"),
    environment: requiredAttribute(resourceAttributes, "trust.skill.environment"),
    deploymentKey: requiredAttribute(resourceAttributes, "trust.skill.deployment_key"),
    envelope: envelope(requiredAttribute(resourceAttributes, "trust.skill.envelope")),
    runtimeIdentity: requiredAttribute(resourceAttributes, "trust.skill.runtime_identity"),
    processIdentity: requiredAttribute(resourceAttributes, "trust.skill.process_identity"),
    facts,
    recordedAt: unixNanoInstant(span.startTimeUnixNano),
  };
}

function parseFactEvents(
  value: unknown,
  eventName: "trust.runner.fact" | "trust.skill.fact",
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    throw new InvalidSkillFactTrace("OTLP Fact batch events must be an array");
  }
  const indexed = value.map((candidate) => {
    const event = record(candidate, "Fact event");
    if (event.name !== eventName) {
      throw new InvalidSkillFactTrace("OTLP event is not a TRUST Fact");
    }
    const values = otlpAttributeValues(event.attributes, "Fact event attributes");
    const index = values.get("trust.fact.index");
    const fact: Record<string, unknown> = {};
    for (const [key, item] of values) {
      if (key === "trust.fact.index") continue;
      if (!key.startsWith("trust.fact.")) {
        throw new InvalidSkillFactTrace(`Fact event attribute ${key} is invalid`);
      }
      const attributeName = key.slice("trust.fact.".length);
      const field = attributeName === "observed_at" ? "observedAt" : attributeName;
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field) || Object.hasOwn(fact, field)) {
        throw new InvalidSkillFactTrace(`Fact event attribute ${key} is invalid or repeated`);
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
      throw new InvalidSkillFactTrace("Fact event attributes are invalid");
    }
    return { index: index as number, fact };
  }).sort((left, right) => left.index - right.index);
  if (indexed.some((entry, index) => entry.index !== index)) {
    throw new InvalidSkillFactTrace("Fact event indexes must be contiguous from zero");
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
  if (!Array.isArray(value)) throw new InvalidSkillFactTrace(`${label} must be an array`);
  const result = new Map<string, OtlpAttributeValue>();
  for (const candidate of value) {
    const attribute = record(candidate, label);
    const key = attribute.key;
    const wrapped = record(attribute.value, `${label} value`);
    if (typeof key !== "string" || result.has(key)) {
      throw new InvalidSkillFactTrace(`${label} contains an invalid or duplicate key`);
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
    throw new InvalidSkillFactTrace(`${label} contains an unsupported value`);
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
      throw new InvalidSkillFactTrace(`${label} arrayValue values must be an array`);
    }
    return array.values.map((item) => otlpValue(record(item, `${label} array item`), label));
  }
  if (value.kvlistValue !== undefined) {
    const list = record(value.kvlistValue, `${label} kvlistValue`);
    if (!Array.isArray(list.values)) {
      throw new InvalidSkillFactTrace(`${label} kvlistValue values must be an array`);
    }
    const result = new Map<string, OtlpAttributeValue>();
    for (const item of list.values) {
      const pair = record(item, `${label} kvlist item`);
      if (typeof pair.key !== "string" || result.has(pair.key)) {
        throw new InvalidSkillFactTrace(`${label} kvlistValue contains an invalid or duplicate key`);
      }
      result.set(pair.key, otlpValue(record(pair.value, `${label} ${pair.key}`), label));
    }
    return Object.fromEntries(result);
  }
  throw new InvalidSkillFactTrace(`${label} contains an unsupported value`);
}

function requiredAttribute(attributes: ReadonlyMap<string, string>, key: string): string {
  const value = attributes.get(key);
  if (value === undefined || value.length === 0) {
    throw new InvalidSkillFactTrace(`OTLP attribute ${key} is required`);
  }
  return value;
}

function unixNanoInstant(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new InvalidSkillFactTrace("OTLP startTimeUnixNano is invalid");
  }
  const milliseconds = BigInt(value) / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidSkillFactTrace("OTLP startTimeUnixNano exceeds the supported range");
  }
  const instant = new Date(Number(milliseconds));
  if (!Number.isFinite(instant.getTime())) {
    throw new InvalidSkillFactTrace("OTLP startTimeUnixNano is not a valid instant");
  }
  return instant.toISOString();
}

function envelope(value: string): "cli" | "mcp-stdio" | "mcp-http" {
  if (value !== "cli" && value !== "mcp-stdio" && value !== "mcp-http") {
    throw new InvalidSkillFactTrace("OTLP Skill envelope is invalid");
  }
  return value;
}

function singleArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new InvalidSkillFactTrace(`${label} must contain exactly one item`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidSkillFactTrace(`${label} must be an object`);
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
