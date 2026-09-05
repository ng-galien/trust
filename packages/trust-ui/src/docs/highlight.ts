import { type HighlightLine, highlightExpressionSource, highlightGherkinSource } from "@trust/gherkin";
import { operationHighlightVocabulary } from "@trust/operation/language";
import { procedureHighlightVocabulary } from "@trust/procedure/language";

const union = (...values: ReadonlyArray<readonly string[] | undefined>): string[] => [
  ...new Set(values.flatMap((value) => value ?? [])),
];
const fragmentHighlightVocabulary = {
  roots: union(operationHighlightVocabulary.roots, procedureHighlightVocabulary.roots),
  functions: union(operationHighlightVocabulary.functions, procedureHighlightVocabulary.functions),
  types: union(operationHighlightVocabulary.types, procedureHighlightVocabulary.types),
  verbs: union(operationHighlightVocabulary.verbs, procedureHighlightVocabulary.verbs),
  cardinalities: union(operationHighlightVocabulary.cardinalities, procedureHighlightVocabulary.cardinalities),
  declarations: procedureHighlightVocabulary.declarations,
  grammar: {
    productions: [
      ...operationHighlightVocabulary.grammar.productions,
      ...procedureHighlightVocabulary.grammar.productions,
    ],
  },
  referenceSlots: union(operationHighlightVocabulary.referenceSlots, procedureHighlightVocabulary.referenceSlots),
};

export function highlight(
  code: string,
  language: string,
  kind?: "operation" | "procedure" | "fragment",
): HighlightLine[] {
  const vocabulary =
    kind === "procedure"
      ? procedureHighlightVocabulary
      : kind === "operation"
        ? operationHighlightVocabulary
        : fragmentHighlightVocabulary;
  if (language === "gherkin") return highlightGherkinSource(code, vocabulary);
  if (language === "jsonata") return highlightExpressionSource(code, operationHighlightVocabulary);
  const value = code.endsWith("\n") ? code.slice(0, -1) : code;
  return value.split("\n").map((line) => [{ text: line, cls: "" }]);
}
