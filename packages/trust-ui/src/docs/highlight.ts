import { highlightExpressionSource, highlightGherkinSource, type HighlightLine } from "@trust/gherkin";
import { operationHighlightVocabulary } from "@trust/operation/language";
import { procedureHighlightVocabulary } from "@trust/procedure/language";

export function highlight(code: string, language: string, kind?: "operation" | "procedure" | "fragment"): HighlightLine[] {
  const vocabulary = kind === "procedure"
    ? procedureHighlightVocabulary
    : kind === "operation"
      ? operationHighlightVocabulary
      : {};
  if (language === "gherkin") return highlightGherkinSource(code, vocabulary);
  if (language === "jsonata") return highlightExpressionSource(code, operationHighlightVocabulary);
  const value = code.endsWith("\n") ? code.slice(0, -1) : code;
  return value.split("\n").map((line) => [{ text: line, cls: "" }]);
}
