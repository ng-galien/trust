import {
  materializeTemplate,
  TemplateDefinitionError,
  type TemplateDocumentContext,
  validateTemplateParameters,
} from "@trust/extension-sdk";
import { procedureScopeFragment } from "@trust/procedure";
import { type Diagnostic, DiagnosticSeverity, type Position, type Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !value.includes("\0");
export function templateContext(value: unknown): TemplateDocumentContext | undefined {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !["uri", "parameters", "materialized"].includes(key)) ||
    !text(value.uri, 8192)
  )
    return undefined;
  if (value.materialized !== undefined && typeof value.materialized !== "boolean") return undefined;
  if (value.parameters === null) return { uri: value.uri, parameters: null };
  try {
    const parameters = validateTemplateParameters(value.parameters);
    if (value.materialized && parameters.length) return undefined;
    return {
      uri: value.uri,
      parameters,
      ...(value.materialized === undefined ? {} : { materialized: value.materialized }),
    };
  } catch (error) {
    if (error instanceof TemplateDefinitionError) return undefined;
    throw error;
  }
}

/** An ephemeral authoring view; synthetic containment is never compiled as a published resource. */
export function templateProjection(original: TextDocument, context: TemplateDocumentContext) {
  const raw = original.getText();
  const materialized = context.materialized
    ? { source: raw, issues: [], placeholders: [], segments: [] }
    : materializeTemplate(raw, context.parameters ?? []);
  const diagnostics: Diagnostic[] = materialized.issues.map((issue) => ({
    range: { start: original.positionAt(issue.start), end: original.positionAt(issue.end) },
    severity: issue.unresolved ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
    code: issue.code,
    message: issue.message,
    source: "trust-template",
  }));
  const { source, segments } = materialized;
  const { recognized: fragment, prefix } = procedureScopeFragment(source);
  const projected = TextDocument.create(original.uri, original.languageId, original.version, prefix + source);
  const toProjected = (position: Position): Position => {
    const offset = original.offsetAt(position);
    let delta = prefix.length;
    for (const segment of segments) {
      if (offset < segment.start) break;
      if (offset < segment.end) return projected.positionAt(prefix.length + segment.projectedStart);
      delta += segment.projectedEnd - segment.projectedStart - (segment.end - segment.start);
    }
    return projected.positionAt(offset + delta);
  };
  const toOriginal = (position: Position, end = false): Position => {
    const offset = projected.offsetAt(position) - prefix.length;
    let delta = 0;
    for (const segment of segments) {
      if (offset < segment.projectedStart) break;
      if (offset < segment.projectedEnd) return original.positionAt(end ? segment.end : segment.start);
      delta += segment.projectedEnd - segment.projectedStart - (segment.end - segment.start);
    }
    return original.positionAt(Math.max(0, offset - delta));
  };
  const range = (value: Range): Range => ({ start: toOriginal(value.start), end: toOriginal(value.end, true) });
  const safeRange = (value: Range): boolean => {
    const start = projected.offsetAt(value.start) - prefix.length;
    const end = projected.offsetAt(value.end) - prefix.length;
    return start >= 0 && !segments.some((segment) => start < segment.projectedEnd && end > segment.projectedStart);
  };
  return {
    original,
    document: projected,
    diagnostics,
    fragment,
    toProjected,
    range,
    safeRange,
    unresolved: diagnostics.length > 0,
    dependsOnUnresolved: (value: Range) =>
      materialized.issues.some((issue) => {
        const start = original.offsetAt(value.start);
        const end = original.offsetAt(value.end);
        return issue.affectsSource && start < issue.end && end >= issue.start;
      }),
    inPlaceholder: (position: Position) =>
      materialized.placeholders.some(
        (token) => original.offsetAt(position) >= token.start && original.offsetAt(position) < token.end,
      ),
  };
}
