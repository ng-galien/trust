/** Reusable authoring text, independent from published Operation and Procedure versions. */
export interface TemplateParameter {
  readonly name: string;
  readonly description: string;
  readonly defaultValue?: string;
}

export interface SourceTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly parameters: readonly TemplateParameter[];
  readonly revision: number;
  readonly builtIn: boolean;
}

export interface TemplateSaveRequest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly parameters: readonly TemplateParameter[];
  readonly expectedRevision: number;
}

export interface TemplateRenderRequest {
  readonly id: string;
  readonly expectedRevision: number;
  readonly values: Readonly<Record<string, string>>;
}

export interface TemplateRenderResult {
  readonly source: string;
}

/** Authoring context on the existing TRUST language-server connection; null clears it. */
export interface TemplateDocumentContext {
  readonly uri: string;
  readonly parameters: readonly TemplateParameter[] | null;
  /** Already substituted text: analyze its destination language without scanning placeholders. */
  readonly materialized?: boolean;
}

/** Immutable semantic bounds; public tool schemas project these same constraints. */
export const templateConstraints = Object.freeze({
  parameterNamePattern: "[A-Za-z][A-Za-z0-9_]*",
  parameterNameMaxLength: 96,
  parameterDescriptionMaxLength: 2000,
  parameterMaxCount: 64,
  bodyMaxLength: 250_000,
  valueMaxLength: 250_000,
  renderedMaxLength: 1_000_000,
});

export const templateDocumentContextMethod = "trust/templateContext";

/** Offsets refer to the original text. Substitution is literal and never recursive. */
export interface TemplatePlaceholder {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export function scanTemplatePlaceholders(source: string): { placeholders: TemplatePlaceholder[]; malformed: number[] } {
  const placeholders: TemplatePlaceholder[] = [];
  const malformed: number[] = [];
  const token = new RegExp(`\\{\\{(${templateConstraints.parameterNamePattern})\\}\\}`, "y");
  let cursor = 0;
  while (cursor < source.length) {
    cursor = source.indexOf("{{", cursor);
    if (cursor === -1) break;
    token.lastIndex = cursor;
    const match = token.exec(source);
    if (match?.[1]) {
      placeholders.push({ name: match[1], start: cursor, end: token.lastIndex });
      cursor = token.lastIndex;
    } else {
      malformed.push(cursor);
      cursor += 2;
    }
  }
  return { placeholders, malformed };
}

export function isTemplateParameterName(value: string): boolean {
  return (
    new RegExp(`^${templateConstraints.parameterNamePattern}$`).test(value) &&
    value.length <= templateConstraints.parameterNameMaxLength
  );
}

/** Semantic validation shared by persistence and authoring adapters. */
export class TemplateDefinitionError extends Error {}
const templateRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const templateText = (value: unknown, max: number, empty = true): value is string =>
  typeof value === "string" && value.length <= max && !value.includes("\0") && (empty || value.trim().length > 0);

export function validateTemplateParameters(value: unknown): TemplateParameter[] {
  if (!Array.isArray(value) || value.length > templateConstraints.parameterMaxCount)
    throw new TemplateDefinitionError("Invalid template parameters");
  const seen = new Set<string>();
  return value.map((parameter: unknown) => {
    if (
      !templateRecord(parameter) ||
      Object.keys(parameter).some((key) => !["name", "description", "defaultValue"].includes(key)) ||
      !templateText(parameter.name, templateConstraints.parameterNameMaxLength, false) ||
      !isTemplateParameterName(parameter.name) ||
      !templateText(parameter.description, templateConstraints.parameterDescriptionMaxLength) ||
      (parameter.defaultValue !== undefined &&
        !templateText(parameter.defaultValue, templateConstraints.valueMaxLength))
    )
      throw new TemplateDefinitionError("Invalid template parameter");
    if (seen.has(parameter.name))
      throw new TemplateDefinitionError("Parameters must describe each body placeholder exactly once");
    seen.add(parameter.name);
    return {
      name: parameter.name,
      description: parameter.description,
      ...(typeof parameter.defaultValue === "string" ? { defaultValue: parameter.defaultValue } : {}),
    };
  });
}

export interface TemplateIssue {
  readonly start: number;
  readonly end: number;
  readonly code: string;
  readonly message: string;
  readonly unresolved: boolean;
  /** This original range has no complete destination-language value yet. */
  readonly affectsSource: boolean;
}
export interface TemplateSubstitution extends TemplatePlaceholder {
  readonly projectedStart: number;
  readonly projectedEnd: number;
}

/** Validate a definition without requiring defaults: a saved template may require explicit values. */
export function validateTemplateDefinition(body: string, parameters: readonly TemplateParameter[]): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const issue = (start: number, end: number, code: string, message: string, affectsSource = false) =>
    issues.push({ start, end, code, message, unresolved: false, affectsSource });
  const bodyEnd = Math.min(1, body.length);
  if (!templateText(body, templateConstraints.bodyMaxLength, false))
    issue(0, bodyEnd, "template-body", "Invalid template body");
  const scan = scanTemplatePlaceholders(body);
  for (const start of scan.malformed)
    issue(start, start + 2, "template-placeholder", "Use {{name}} for template parameters", true);
  const declared = new Set(parameters.map(({ name }) => name));
  const used = new Set(scan.placeholders.map(({ name }) => name));
  for (const token of scan.placeholders)
    if (!declared.has(token.name))
      issue(
        token.start,
        token.end,
        "template-parameter-undeclared",
        "Every placeholder must declare a parameter",
        true,
      );
  for (const parameter of parameters)
    if (!used.has(parameter.name))
      issue(
        0,
        Math.min(1, body.length),
        "template-parameter-unused",
        "Parameters must describe each body placeholder exactly once",
      );
  return issues;
}

/** Literal, non-recursive substitution. Unresolved authoring values stay visible; consumers must not accept its issues. */
export function materializeTemplate(body: string, parameters: readonly TemplateParameter[], values: unknown = {}) {
  if (
    !templateRecord(values) ||
    Object.keys(values).some((name) => !parameters.some((parameter) => parameter.name === name)) ||
    Object.values(values).some((value) => !templateText(value, templateConstraints.valueMaxLength))
  )
    throw new TemplateDefinitionError("Unexpected template values or invalid text");
  const issues = validateTemplateDefinition(body, parameters);
  const placeholders = scanTemplatePlaceholders(body).placeholders;
  const resolved = new Map<string, string>();
  for (const parameter of parameters) {
    const value = Object.hasOwn(values, parameter.name) ? values[parameter.name] : parameter.defaultValue;
    if (typeof value === "string") resolved.set(parameter.name, value);
    else
      for (const token of placeholders.filter(({ name }) => name === parameter.name))
        issues.push({
          start: token.start,
          end: token.end,
          code: "template-parameter-unresolved",
          message: `Missing template value ${parameter.name}; validation depends on its rendered value`,
          unresolved: true,
          affectsSource: true,
        });
  }
  let length = body.length;
  for (const token of placeholders)
    length += (resolved.get(token.name)?.length ?? token.end - token.start) - (token.end - token.start);
  if (length > templateConstraints.renderedMaxLength) {
    issues.push({
      start: 0,
      end: Math.min(1, body.length),
      code: "template-projection-limit",
      message: "Rendered template exceeds one million characters",
      unresolved: false,
      affectsSource: false,
    });
    return { source: body, issues, placeholders, segments: [] as TemplateSubstitution[] };
  }
  const segments: TemplateSubstitution[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let projected = 0;
  for (const token of placeholders) {
    const before = body.slice(cursor, token.start);
    const replacement = resolved.get(token.name) ?? body.slice(token.start, token.end);
    parts.push(before, replacement);
    projected += before.length;
    segments.push({ ...token, projectedStart: projected, projectedEnd: projected + replacement.length });
    projected += replacement.length;
    cursor = token.end;
  }
  parts.push(body.slice(cursor));
  return { source: parts.join(""), issues, placeholders, segments };
}
