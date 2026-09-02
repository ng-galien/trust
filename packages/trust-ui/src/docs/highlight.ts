import { highlightExpressionSource, highlightGherkinSource, type HighlightLine } from "@trust/gherkin";
import { operationHighlightVocabulary } from "@trust/operation/language";
import { procedureHighlightVocabulary } from "@trust/procedure/language";

const union = (...values: ReadonlyArray<readonly string[] | undefined>): string[] => [...new Set(values.flatMap((value) => value ?? []))];
const fragmentHighlightVocabulary = {
  roots: union(operationHighlightVocabulary.roots, procedureHighlightVocabulary.roots),
  functions: union(operationHighlightVocabulary.functions, procedureHighlightVocabulary.functions),
  types: union(operationHighlightVocabulary.types, procedureHighlightVocabulary.types),
  verbs: union(operationHighlightVocabulary.verbs, procedureHighlightVocabulary.verbs),
};

export function highlight(code: string, language: string, kind?: "operation" | "procedure" | "fragment"): HighlightLine[] {
  const vocabulary = kind === "procedure"
    ? procedureHighlightVocabulary
    : kind === "operation"
      ? operationHighlightVocabulary
      : fragmentHighlightVocabulary;
  if (language === "gherkin") return highlightGherkinSource(code, vocabulary);
  if (language === "jsonata") return highlightExpressionSource(code, operationHighlightVocabulary);
  const value = code.endsWith("\n") ? code.slice(0, -1) : code;
  return value.split("\n").map((line) => [{ text: line, cls: "" }]);
}
