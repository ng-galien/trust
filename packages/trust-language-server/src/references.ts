import type { Step } from "@cucumber/messages";
import {
  continuationLineIndexes,
  GherkinSyntaxError,
  parseGherkin,
  parseStepGrammar,
  splitLines,
  stepGrammarExpectations,
  tokenizeSentence,
} from "@trust/gherkin";
import type { CompiledOperation } from "@trust/operation";
import { parseResourceReference, selectVersion } from "@trust/operation/version";
import type { CompiledProcedure } from "@trust/procedure";
import { procedureStepGrammar } from "@trust/procedure/language";
import type { Range } from "vscode-languageserver/node";

export interface ResourceReference {
  readonly range: Range;
  readonly target: string;
  readonly markdown: string;
}

/** Resolve only canonical reference slots; prose, expressions and lookalike strings never become links. */
export function resourceReferences(
  source: string,
  operations: readonly CompiledOperation[],
  procedures: readonly CompiledProcedure[],
): ResourceReference[] {
  let document: ReturnType<typeof parseGherkin>;
  try {
    document = parseGherkin(source);
  } catch (error) {
    if (error instanceof GherkinSyntaxError) return [];
    throw error;
  }
  const lines = splitLines(source);
  const references: ResourceReference[] = [];
  const scenarios =
    document.feature?.children.flatMap((child) =>
      child.scenario
        ? [child.scenario]
        : (child.rule?.children.flatMap((nested) => (nested.scenario ? [nested.scenario] : [])) ?? []),
    ) ?? [];
  for (const scenario of scenarios)
    for (const step of scenario.steps) {
      let tokens: ReturnType<typeof tokenizeSentence>;
      try {
        tokens = tokenizeSentence(step.text);
      } catch {
        continue;
      }
      const match = parseStepGrammar(procedureStepGrammar, tokens, "scenario");
      if (!match || (match.production !== "check" && match.production !== "invocation")) continue;
      const index = tokens.findIndex(
        (token, at) =>
          token.kind === "quoted" &&
          stepGrammarExpectations(procedureStepGrammar, tokens.slice(0, at), "scenario").some(
            (value) => value.kind === "quoted" && value.slot === "operation",
          ),
      );
      const token = tokens[index];
      if (!token) continue;
      const range = physicalTokenRange(lines, step, token.start + 1, token.end - 1);
      if (!range) continue;
      const kind = match.production === "check" ? "operation" : "procedure";
      const reference = parseResourceReference(token.value);
      if (!reference) continue;
      const candidates =
        kind === "operation"
          ? operations.filter((value) => value.operation === reference.name)
          : procedures.filter((value) => value.procedure === reference.name);
      const version = selectVersion(
        candidates.map((value) => value.version),
        reference.selector,
      );
      const resource =
        kind === "operation"
          ? operations.find((value) => value.operation === reference.name && value.version === version)
          : procedures.find((value) => value.procedure === reference.name && value.version === version);
      if (!resource) continue;
      const target = `trust-resource://${kind}/${encodeURIComponent(reference.name)}?version=${encodeURIComponent(resource.version)}`;
      const identity = `${kind === "operation" ? "Operation" : "Procedure"} ${reference.name}@${resource.version}`;
      const parts = [`**${escapeMarkdown(identity)}**`, escapeMarkdown(resource.title)];
      if (resource.description) parts.push(escapeMarkdown(resource.description));
      if ("input" in resource) {
        parts.push(
          `Inputs: ${schemaFields(resource.input.properties)}`,
          `Produced: ${schemaFields(resource.produced.properties)}`,
        );
      } else {
        parts.push(
          `Root inputs: ${
            resource.roles
              .filter((role) => role.source.kind === "plan-input")
              .map(
                (role) =>
                  `${escapeMarkdown(role.name)}: ${escapeMarkdown(role.type)}${role.cardinality === "many" ? "\\[\\]" : ""}`,
              )
              .join(", ") || "none"
          }`,
        );
        parts.push(`${resource.checks.length} Checks; ${resource.invocations.length} child Procedure invocations`);
      }
      parts.push(`[Open ${kind === "operation" ? "Operation" : "Procedure"}](${target})`);
      references.push({ range, target, markdown: parts.join("\n\n") });
    }
  return references;
}

/** Map the canonical folded sentence token back to its physical continuation segment. */
function physicalTokenRange(lines: readonly string[], step: Step, start: number, end: number): Range | undefined {
  const indexes = [step.location.line - 1, ...continuationLineIndexes(lines, step.location.line - 1)];
  let offset = 0;
  const segments = indexes.map((line, index) => {
    const text = lines[line] ?? "";
    const prefix = index === 0 ? (step.location.column ?? 1) - 1 + step.keyword.length : 0;
    const remaining = text.slice(prefix);
    return { line, character: prefix + remaining.length - remaining.trimStart().length, text: remaining.trim() };
  });
  if (segments.map((value) => value.text).join(" ") !== step.text) return undefined;
  for (const segment of segments) {
    if (start >= offset && end <= offset + segment.text.length)
      return {
        start: { line: segment.line, character: segment.character + start - offset },
        end: { line: segment.line, character: segment.character + end - offset },
      };
    offset += segment.text.length + 1;
  }
  return undefined;
}

function schemaFields(
  fields: Readonly<Record<string, { readonly type: string; readonly items?: { readonly type: string } }>>,
): string {
  return (
    Object.entries(fields)
      .map(
        ([name, value]) =>
          `${escapeMarkdown(name)}: ${escapeMarkdown(value.type === "array" ? `${value.items?.type ?? "value"}[]` : value.type)}`,
      )
      .join(", ") || "none"
  );
}

function escapeMarkdown(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code !== 0x7f && (code > 0x1f || code === 0x09 || code === 0x0a || code === 0x0d);
    })
    .join("")
    .replace(/[\\`*_{}[\]()#+.!<>|~:/=-]/g, "\\$&");
}
