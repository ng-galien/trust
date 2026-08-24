export {
  GherkinSyntaxError,
  hasGherkinTag,
  normalizeGherkinSource,
  parseGherkin,
} from "./document.js";
export {
  continuationLineIndexes,
  isContinuationLine,
  joinContinuations,
  splitLines,
} from "./continuation.js";
export { formatGherkinSource, type FormatOptions } from "./format.js";
export { highlightExpressionSource, highlightGherkinSource, highlightTokenTable } from "./highlight.js";
export type { HighlightKind, HighlightLine, HighlightToken, HighlightTokenDefinition, HighlightTokenKind, HighlightTokenTone, HighlightVocabulary } from "./highlight.js";
export {
  documentRange,
  sourceLineRange,
  sourceValueRange,
} from "./source.js";
export type {
  Located,
  SourcePosition,
  SourceRange,
} from "./source.js";
export {
  isExpressionIdentifierPart,
  isExpressionIdentifierStart,
  SentenceCursor,
  SentenceSyntaxError,
  tokenizeSentence,
} from "./sentence.js";
export type { SentenceToken } from "./sentence.js";
export {
  matchStepGrammar,
  parseStepGrammar,
  parseStepGrammarPrefix,
  stepChoice,
  stepGrammarExpectations,
  stepGrammarFailure,
  stepLiteral,
  stepOneOf,
  stepOptional,
  stepQuoted,
  stepRepeat,
  stepSequence,
} from "./step-grammar.js";
export type {
  StepGrammar,
  StepGrammarCapture,
  StepGrammarExpectation,
  StepGrammarExpression,
  StepGrammarFailure,
  StepGrammarMatch,
  StepGrammarPrefix,
  StepGrammarProduction,
} from "./step-grammar.js";
