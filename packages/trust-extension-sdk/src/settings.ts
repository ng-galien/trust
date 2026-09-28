import { assertNoSecretLikeValue } from "./authority.js";
import { matchExtensionSettingProperty } from "./match.js";

/**
 * Extension settings contract: a closed JSON Schema subset declared by `extension.json` under `settings`.
 * Values belong to one installation and are stored by the runtime, never in the package.
 */
export type ExtensionSettingValue = string | number | boolean;
export type ExtensionSettingsValues = Readonly<Record<string, ExtensionSettingValue>>;

/** `environment-credential`: the value names one allowed environment variable; the runtime resolves it at start. */
export type ExtensionStringSettingFormat = "absolute-path" | "uri" | "environment-credential";

interface ExtensionSettingAnnotations {
  readonly title?: string;
  readonly description?: string;
}
export interface ExtensionStringSetting extends ExtensionSettingAnnotations {
  readonly type: "string";
  readonly format?: ExtensionStringSettingFormat;
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly default?: string;
}
export interface ExtensionIntegerSetting extends ExtensionSettingAnnotations {
  readonly type: "integer";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
}
export interface ExtensionNumberSetting extends ExtensionSettingAnnotations {
  readonly type: "number";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
}
export interface ExtensionBooleanSetting extends ExtensionSettingAnnotations {
  readonly type: "boolean";
  readonly default?: boolean;
}
export type ExtensionSettingProperty =
  | ExtensionStringSetting
  | ExtensionIntegerSetting
  | ExtensionNumberSetting
  | ExtensionBooleanSetting;

/** A cross-field branch: the listed settings are present. */
export interface ExtensionSettingsRequirement {
  readonly required: readonly string[];
}
export interface ExtensionSettingsSchema {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly properties: Readonly<Record<string, ExtensionSettingProperty>>;
  readonly required?: readonly string[];
  /** Exactly one branch holds. */
  readonly oneOf?: readonly ExtensionSettingsRequirement[];
  /** At least one branch holds. */
  readonly anyOf?: readonly ExtensionSettingsRequirement[];
  /** When the key is present, the listed settings are required. */
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
}

export interface ExtensionSettingsIssue {
  /** JSON Pointer of the offending setting, or "" for a cross-field constraint. */
  readonly path: string;
  readonly message: string;
}
export type ExtensionSettingsValidation =
  | { readonly valid: true; readonly values: ExtensionSettingsValues; readonly effective: ExtensionSettingsValues }
  | { readonly valid: false; readonly issues: readonly ExtensionSettingsIssue[] };

/** Read projection: stored values only; a credential setting shows the environment variable name, never its value. */
export interface ExtensionSettingsView {
  readonly extension: string;
  readonly schema: ExtensionSettingsSchema;
  readonly settings: ExtensionSettingsValues;
  readonly effective: ExtensionSettingsValues;
  /** 0 while the installation still uses its initial declared values. */
  readonly revision: number;
  readonly source: "installation" | "runtime";
}
export interface ExtensionSettingsUpdate {
  readonly extension: string;
  readonly expectedRevision: number;
  readonly settings: ExtensionSettingsValues;
}
export interface ExtensionSettingsUpdateResult {
  readonly extension: import("./extension.js").ExtensionDescriptor;
  readonly settings: ExtensionSettingsView;
  /** The renewed instance was running and its newly selected store has no schema; run prepare then start. */
  readonly preparationRequired: boolean;
}

/** A lifecycle hook reports a storage refusal by throwing an error whose `failure` is one of these values. */
export const EXTENSION_STORAGE_FAILURES = ["storage-unprepared", "storage-incompatible"] as const;
export type ExtensionStorageFailure = (typeof EXTENSION_STORAGE_FAILURES)[number];
export function isExtensionStorageFailure(value: unknown): value is ExtensionStorageFailure {
  return typeof value === "string" && (EXTENSION_STORAGE_FAILURES as readonly string[]).includes(value);
}

const SETTING_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENVIRONMENT = /^(NODE_|LD_|DYLD_)|^(PATH|SYSTEMROOT)$/;

export class ExtensionSettingsSchemaError extends TypeError {}

/** Validate a manifest `settings` declaration; unknown keywords are refused rather than ignored. */
export function parseExtensionSettingsSchema(value: unknown): ExtensionSettingsSchema {
  const fail = (message: string): never => {
    throw new ExtensionSettingsSchemaError(`Invalid settings schema: ${message}`);
  };
  const root = record(value) ?? fail("settings must be a JSON Schema object");
  allowKeys(
    root,
    [
      "type",
      "additionalProperties",
      "properties",
      "required",
      "oneOf",
      "anyOf",
      "dependentRequired",
      "title",
      "description",
    ],
    "settings",
    fail,
  );
  if (root.type !== "object") fail('settings.type must be "object"');
  if (root.additionalProperties !== false) fail("settings.additionalProperties must be false");
  const rawProperties = record(root.properties) ?? fail("settings.properties must be an object");
  const properties: Record<string, ExtensionSettingProperty> = {};
  for (const [name, raw] of Object.entries(rawProperties)) {
    if (!SETTING_NAME.test(name)) fail(`settings.properties.${name} is not a valid setting name`);
    properties[name] = parseProperty(name, raw, fail);
  }
  const names = (list: unknown, label: string): string[] => {
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !Object.hasOwn(properties, item)))
      return fail(`${label} must list declared settings`);
    if (new Set(list).size !== list.length) fail(`${label} must not repeat a setting`);
    return list as string[];
  };
  const branches = (list: unknown, label: string): ExtensionSettingsRequirement[] => {
    if (!Array.isArray(list) || list.length < 2) return fail(`${label} must list at least two branches`);
    return list.map((raw, index) => {
      const branch = record(raw) ?? fail(`${label}[${index}] must be an object`);
      allowKeys(branch, ["required"], `${label}[${index}]`, fail);
      const required = names(branch.required, `${label}[${index}].required`);
      if (required.length === 0) fail(`${label}[${index}].required must not be empty`);
      return { required };
    });
  };
  const schema: {
    -readonly [K in keyof ExtensionSettingsSchema]: ExtensionSettingsSchema[K];
  } = { type: "object", additionalProperties: false, properties };
  if (root.required !== undefined) schema.required = names(root.required, "settings.required");
  if (root.oneOf !== undefined) schema.oneOf = branches(root.oneOf, "settings.oneOf");
  if (root.anyOf !== undefined) schema.anyOf = branches(root.anyOf, "settings.anyOf");
  if (root.dependentRequired !== undefined) {
    const dependencies = record(root.dependentRequired) ?? fail("settings.dependentRequired must be an object");
    const parsed: Record<string, readonly string[]> = {};
    for (const [name, list] of Object.entries(dependencies)) {
      if (!Object.hasOwn(properties, name)) fail(`settings.dependentRequired.${name} is not a declared setting`);
      parsed[name] = names(list, `settings.dependentRequired.${name}`);
    }
    schema.dependentRequired = parsed;
  }
  for (const [name, property] of Object.entries(properties))
    if (property.default !== undefined) {
      const issue = checkValue(name, property, property.default);
      if (issue) fail(`settings.properties.${name}.default ${issue}`);
    }
  return schema;
}

function parseProperty(name: string, value: unknown, fail: (message: string) => never): ExtensionSettingProperty {
  const label = `settings.properties.${name}`;
  const raw = record(value) ?? fail(`${label} must be an object`);
  const annotations = (target: Record<string, unknown>) => {
    for (const key of ["title", "description"] as const)
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "string" || !raw[key]) fail(`${label}.${key} must be a non-empty string`);
        target[key] = raw[key];
      }
    return target;
  };
  const bound = (key: string, integer: boolean) => {
    if (raw[key] === undefined) return undefined;
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || (integer && !Number.isInteger(raw[key])))
      fail(`${label}.${key} must be ${integer ? "an integer" : "a finite number"}`);
    return raw[key] as number;
  };
  const common = ["type", "title", "description", "default"];
  switch (raw.type) {
    case "string": {
      allowKeys(raw, [...common, "format", "enum", "minLength", "maxLength", "pattern"], label, fail);
      const property = annotations({ type: "string" });
      if (raw.format !== undefined) {
        if (!["absolute-path", "uri", "environment-credential"].includes(raw.format as string))
          fail(`${label}.format must be absolute-path, uri or environment-credential`);
        property.format = raw.format;
      }
      if (raw.enum !== undefined) {
        if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.some((item) => typeof item !== "string"))
          fail(`${label}.enum must list strings`);
        property.enum = raw.enum;
      }
      for (const key of ["minLength", "maxLength"]) {
        const limit = bound(key, true);
        if (limit !== undefined) {
          if (limit < 0) fail(`${label}.${key} must not be negative`);
          property[key] = limit;
        }
      }
      if (raw.pattern !== undefined) {
        if (typeof raw.pattern !== "string") fail(`${label}.pattern must be a string`);
        try {
          new RegExp(raw.pattern as string, "u");
        } catch {
          fail(`${label}.pattern is not a valid regular expression`);
        }
        property.pattern = raw.pattern;
      }
      if (raw.format === "environment-credential") {
        const allowed = raw.enum as string[] | undefined;
        if (!allowed || allowed.some((item) => !ENVIRONMENT_NAME.test(item) || RESERVED_ENVIRONMENT.test(item)))
          fail(`${label} must list its allowed environment variable names in enum`);
        if (raw.default !== undefined) fail(`${label} is a credential reference and cannot declare a default`);
      }
      if (raw.default !== undefined) property.default = raw.default;
      return property as unknown as ExtensionStringSetting;
    }
    case "integer":
    case "number": {
      allowKeys(raw, [...common, "minimum", "maximum"], label, fail);
      const property = annotations({ type: raw.type });
      const integer = raw.type === "integer";
      for (const key of ["minimum", "maximum"]) {
        const limit = bound(key, integer);
        if (limit !== undefined) property[key] = limit;
      }
      if (raw.default !== undefined) property.default = raw.default;
      return property as unknown as ExtensionIntegerSetting | ExtensionNumberSetting;
    }
    case "boolean": {
      allowKeys(raw, common, label, fail);
      const property = annotations({ type: "boolean" });
      if (raw.default !== undefined) property.default = raw.default;
      return property as unknown as ExtensionBooleanSetting;
    }
    default:
      return fail(`${label}.type must be string, integer, number or boolean`);
  }
}

/** Validate one installation's values; returns every issue, and on success the effective values with defaults. */
export function validateExtensionSettings(
  schema: ExtensionSettingsSchema,
  value: unknown,
): ExtensionSettingsValidation {
  const values = record(value);
  if (!values) return { valid: false, issues: [{ path: "", message: "settings must be a JSON object" }] };
  const issues: ExtensionSettingsIssue[] = [];
  for (const [name, item] of Object.entries(values)) {
    const property = schema.properties[name];
    if (!property) {
      issues.push({ path: `/${name}`, message: `${name} is not a declared setting` });
      continue;
    }
    const issue = checkValue(name, property, item);
    if (issue) issues.push({ path: `/${name}`, message: `${name} ${issue}` });
  }
  const present = (name: string) => Object.hasOwn(values, name);
  for (const name of schema.required ?? [])
    if (!present(name)) issues.push({ path: `/${name}`, message: `${name} is required` });
  const holds = (branch: ExtensionSettingsRequirement) => branch.required.every(present);
  const describe = (branches: readonly ExtensionSettingsRequirement[]) =>
    branches.map((branch) => branch.required.join(" + ")).join(", ");
  if (schema.oneOf) {
    const matched = schema.oneOf.filter(holds).length;
    if (matched !== 1)
      issues.push({
        path: "",
        message: `exactly one of ${describe(schema.oneOf)} must be configured (${matched === 0 ? "none is" : `${matched} are`} configured)`,
      });
  }
  if (schema.anyOf && !schema.anyOf.some(holds))
    issues.push({ path: "", message: `at least one of ${describe(schema.anyOf)} must be configured` });
  for (const [name, dependencies] of Object.entries(schema.dependentRequired ?? {}))
    if (present(name))
      for (const dependency of dependencies)
        if (!present(dependency))
          issues.push({ path: `/${dependency}`, message: `${dependency} is required when ${name} is configured` });
  if (issues.length) return { valid: false, issues };
  const stored = values as ExtensionSettingsValues;
  const effective: Record<string, ExtensionSettingValue> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const item = present(name) ? stored[name] : property.default;
    if (item !== undefined) effective[name] = item;
  }
  return { valid: true, values: { ...stored }, effective };
}

/** Settings whose value names an environment variable holding the credential. */
export function extensionCredentialSettings(schema: ExtensionSettingsSchema): string[] {
  return Object.entries(schema.properties)
    .filter(([, property]) =>
      matchExtensionSettingProperty(property, {
        string: (text) => text.format === "environment-credential",
        integer: () => false,
        number: () => false,
        boolean: () => false,
      }),
    )
    .map(([name]) => name);
}

export function formatExtensionSettingsIssues(issues: readonly ExtensionSettingsIssue[]): string {
  return `Extension settings are invalid: ${issues.map((issue) => issue.message).join("; ")}.`;
}

function checkValue(name: string, property: ExtensionSettingProperty, value: unknown): string | undefined {
  const numeric = (bounds: ExtensionIntegerSetting | ExtensionNumberSetting, integer: boolean) => {
    if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)))
      return `must be ${integer ? "an integer" : "a number"}`;
    if (bounds.minimum !== undefined && value < bounds.minimum) return `must be at least ${bounds.minimum}`;
    if (bounds.maximum !== undefined && value > bounds.maximum) return `must be at most ${bounds.maximum}`;
    return undefined;
  };
  return matchExtensionSettingProperty<string | undefined>(property, {
    string: (text) => checkString(name, text, value),
    integer: (bounds) => numeric(bounds, true),
    number: (bounds) => numeric(bounds, false),
    boolean: () => (typeof value === "boolean" ? undefined : "must be a boolean"),
  });
}

function checkString(name: string, property: ExtensionStringSetting, value: unknown): string | undefined {
  if (typeof value !== "string") return "must be a string";
  if (property.format === "environment-credential")
    return property.enum?.includes(value)
      ? undefined
      : `must name one of the allowed environment variables: ${property.enum?.join(", ")}`;
  if (property.enum && !property.enum.includes(value)) return `must be one of: ${property.enum.join(", ")}`;
  if (property.minLength !== undefined && value.length < property.minLength)
    return `must contain at least ${property.minLength} characters`;
  if (property.maxLength !== undefined && value.length > property.maxLength)
    return `must contain at most ${property.maxLength} characters`;
  if (property.pattern !== undefined && !new RegExp(property.pattern, "u").test(value))
    return `must match the pattern ${property.pattern}`;
  if (property.format === "absolute-path" && !value.startsWith("/")) return "must be an absolute path";
  if (property.format === "uri") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return "must be an absolute URI";
    }
    if (url.password) return "must not embed a password; declare a credential reference instead";
  }
  try {
    assertNoSecretLikeValue(value, name);
  } catch {
    return "contains a secret-like value; declare a credential reference instead";
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function allowKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  fail: (message: string) => never,
) {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) fail(`${label}.${unknown} is not a supported keyword`);
}
