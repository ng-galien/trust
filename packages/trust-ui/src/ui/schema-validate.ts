import { i18next } from "../i18n/index.js";
import type { JsonObject } from "../types.js";

/* Small JSON Schema validator for the flat object schemas TRUST contracts use.
   Mirrors what the runtime enforces (Ajv, strict) closely enough to guide a form before submit. */

export interface PropertySpec {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  items?: PropertySpec;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  description?: string;
  title?: string;
  default?: unknown;
  properties?: Record<string, PropertySpec>;
  required?: string[];
  additionalProperties?: boolean | PropertySpec;
}

export interface ObjectSchema {
  properties?: Record<string, PropertySpec>;
  required?: string[];
  additionalProperties?: boolean | PropertySpec;
}

export interface FieldIssue {
  field: string;
  /** "missing" for a required field without value, "invalid" otherwise. */
  kind: "missing" | "invalid";
  message: string;
}

export function schemaProperties(schema: JsonObject | ObjectSchema | undefined): Array<{ name: string; spec: PropertySpec; required: boolean }> {
  const typed = (schema ?? {}) as ObjectSchema;
  const required = new Set(typed.required ?? []);
  return Object.entries(typed.properties ?? {}).map(([name, spec]) => ({ name, spec, required: required.has(name) }));
}

export function primaryType(spec: PropertySpec): string | undefined {
  return Array.isArray(spec.type) ? spec.type.find((type) => type !== "null") : spec.type;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

/** Human label of the type: `reference`, `directory`, `url`, `instant`, `string list`… */
export function typeLabel(spec: PropertySpec): string {
  const type = primaryType(spec);
  if (type === "array") return i18next.t("ui.schema.type.list", { type: typeLabel(spec.items ?? {}) });
  if (spec.format?.startsWith("trust-")) return spec.format.slice(6);
  if (spec.format === "date-time") return i18next.t("ui.schema.type.instant");
  if (spec.format === "uri" || spec.format === "url") return i18next.t("ui.schema.type.url");
  if (type === "integer") return i18next.t("ui.schema.type.integer");
  return type ?? i18next.t("ui.schema.type.value");
}

/** Human reading of the constraints: "one of a, b", "at least 1 character", "between 1 and 10"… */
export function constraintHints(spec: PropertySpec): string[] {
  const hints: string[] = [];
  const type = primaryType(spec);
  const target = type === "array" ? (spec.items ?? {}) : spec;
  if (target.enum) hints.push(i18next.t("ui.schema.hint.oneOf", { values: target.enum.map((value) => String(value)).join(", ") }));
  if (target.const !== undefined) hints.push(i18next.t("ui.schema.hint.exactly", { value: String(target.const) }));
  if (target.minLength !== undefined && target.maxLength !== undefined) hints.push(i18next.t("ui.schema.hint.lengthRange", { min: String(target.minLength), max: String(target.maxLength) }));
  else if (target.minLength !== undefined) hints.push(target.minLength === 1 ? i18next.t("ui.schema.hint.notEmpty") : i18next.t("ui.schema.hint.minLength", { count: target.minLength }));
  else if (target.maxLength !== undefined) hints.push(i18next.t("ui.schema.hint.maxLength", { count: target.maxLength }));
  if (target.pattern) hints.push(i18next.t("ui.schema.hint.pattern", { pattern: target.pattern }));
  const low = target.minimum ?? (target.exclusiveMinimum !== undefined ? target.exclusiveMinimum : undefined);
  const high = target.maximum ?? (target.exclusiveMaximum !== undefined ? target.exclusiveMaximum : undefined);
  if (low !== undefined && high !== undefined) hints.push(i18next.t("ui.schema.hint.between", { low: String(low), high: String(high) }));
  else if (low !== undefined) hints.push(target.exclusiveMinimum !== undefined ? i18next.t("ui.schema.hint.greaterThan", { value: String(low) }) : i18next.t("ui.schema.hint.atLeast", { value: String(low) }));
  else if (high !== undefined) hints.push(target.exclusiveMaximum !== undefined ? i18next.t("ui.schema.hint.lessThan", { value: String(high) }) : i18next.t("ui.schema.hint.atMost", { value: String(high) }));
  if (target.multipleOf !== undefined) hints.push(i18next.t("ui.schema.hint.step", { value: String(target.multipleOf) }));
  if (type === "array") {
    if (spec.minItems !== undefined) hints.push(i18next.t("ui.schema.hint.minItems", { count: spec.minItems }));
    if (spec.maxItems !== undefined) hints.push(i18next.t("ui.schema.hint.maxItems", { count: spec.maxItems }));
    if (spec.uniqueItems) hints.push(i18next.t("ui.schema.hint.unique"));
  }
  if (spec.format === "date-time") hints.push(i18next.t("ui.schema.hint.instant"));
  if (spec.format === "trust-directory") hints.push(i18next.t("ui.schema.hint.absoluteDirectory"));
  if (spec.format === "trust-url" || spec.format === "uri" || spec.format === "url") hints.push(i18next.t("ui.schema.hint.httpUrl"));
  return hints;
}

export function validateObject(schema: JsonObject | ObjectSchema | undefined, value: JsonObject): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const { name, spec, required } of schemaProperties(schema)) {
    const current = value[name];
    if (isEmpty(current)) {
      if (required) issues.push({ field: name, kind: "missing", message: i18next.t("ui.schema.message.required") });
      continue;
    }
    const message = validateValue(spec, current);
    if (message) issues.push({ field: name, kind: "invalid", message });
  }
  const typed = (schema ?? {}) as ObjectSchema;
  if (typed.additionalProperties === false) {
    const known = new Set(Object.keys(typed.properties ?? {}));
    for (const extra of Object.keys(value)) {
      if (!known.has(extra) && !isEmpty(value[extra])) issues.push({ field: extra, kind: "invalid", message: i18next.t("ui.schema.message.notDeclared") });
    }
  }
  return issues;
}

/** Returns a message when `value` violates `spec`, undefined when it conforms. */
export function validateValue(spec: PropertySpec, value: unknown): string | undefined {
  const type = primaryType(spec);
  if (spec.const !== undefined && value !== spec.const) return i18next.t("ui.schema.message.mustBe", { value: String(spec.const) });
  if (type === "array") {
    if (!Array.isArray(value)) return i18next.t("ui.schema.message.mustBeList");
    if (spec.minItems !== undefined && value.length < spec.minItems) return i18next.t("ui.schema.message.atLeastItems", { count: spec.minItems });
    if (spec.maxItems !== undefined && value.length > spec.maxItems) return i18next.t("ui.schema.message.atMostItems", { count: spec.maxItems });
    if (spec.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return i18next.t("ui.schema.message.itemsUnique");
    for (const [index, item] of value.entries()) {
      const message = validateValue(spec.items ?? {}, item);
      if (message) return i18next.t("ui.schema.message.item", { index: String(index + 1), message });
    }
    return undefined;
  }
  if (spec.enum && !spec.enum.some((option) => option === value)) return i18next.t("ui.schema.message.mustBeOneOf", { values: spec.enum.map((option) => String(option)).join(", ") });
  if (type === "string") {
    if (typeof value !== "string") return i18next.t("ui.schema.message.mustBeText");
    if (spec.minLength !== undefined && value.length < spec.minLength) return spec.minLength === 1 ? i18next.t("ui.schema.message.mustNotBeEmpty") : i18next.t("ui.schema.message.atLeastCharacters", { count: spec.minLength });
    if (spec.maxLength !== undefined && value.length > spec.maxLength) return i18next.t("ui.schema.message.atMostCharacters", { count: spec.maxLength });
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) return i18next.t("ui.schema.message.mustMatch", { pattern: spec.pattern });
    return formatMessage(spec.format, value);
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || Number.isNaN(value)) return i18next.t("ui.schema.message.mustBeNumber");
    if (type === "integer" && !Number.isInteger(value)) return i18next.t("ui.schema.message.mustBeWholeNumber");
    if (spec.minimum !== undefined && value < spec.minimum) return i18next.t("ui.schema.message.atLeast", { value: String(spec.minimum) });
    if (spec.exclusiveMinimum !== undefined && value <= spec.exclusiveMinimum) return i18next.t("ui.schema.message.greaterThan", { value: String(spec.exclusiveMinimum) });
    if (spec.maximum !== undefined && value > spec.maximum) return i18next.t("ui.schema.message.atMost", { value: String(spec.maximum) });
    if (spec.exclusiveMaximum !== undefined && value >= spec.exclusiveMaximum) return i18next.t("ui.schema.message.lessThan", { value: String(spec.exclusiveMaximum) });
    if (spec.multipleOf !== undefined && Math.abs(value / spec.multipleOf - Math.round(value / spec.multipleOf)) > 1e-9) return i18next.t("ui.schema.message.multipleOf", { value: String(spec.multipleOf) });
    return undefined;
  }
  if (type === "boolean") return typeof value === "boolean" ? undefined : i18next.t("ui.schema.message.mustBeBoolean");
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return i18next.t("ui.schema.message.mustBeObject");
    if (spec.properties) {
      const nested = validateObject(spec as ObjectSchema, value as JsonObject);
      if (nested.length) return i18next.t("ui.schema.message.nested", { field: nested[0]!.field, message: nested[0]!.message });
    }
    return undefined;
  }
  return undefined;
}

function formatMessage(format: string | undefined, value: string): string | undefined {
  switch (format) {
    case "date-time":
      return Number.isNaN(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/.test(value) ? i18next.t("ui.schema.message.instant") : undefined;
    case "trust-directory":
      return value.startsWith("/") ? undefined : i18next.t("ui.schema.message.absoluteDirectory");
    case "trust-url":
    case "uri":
    case "url":
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? undefined : i18next.t("ui.schema.message.httpUrl");
      } catch {
        return i18next.t("ui.schema.message.absoluteUrl");
      }
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? undefined : i18next.t("ui.schema.message.email");
    default:
      return undefined;
  }
}

/** Blank value of the right shape for a field, so forms start typed. */
export function blankValue(spec: PropertySpec): unknown {
  if (spec.default !== undefined) return spec.default;
  const type = primaryType(spec);
  if (type === "array") return [];
  if (type === "object") return {};
  if (type === "boolean") return false;
  return undefined;
}
