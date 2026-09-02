import type { GherkinDocument, Step } from "@cucumber/messages";

import { GherkinSyntaxError, parseGherkin } from "./document.js";
import { isExpressionIdentifierPart, isExpressionIdentifierStart, tokenizeSentence } from "./sentence.js";

export const highlightTokenTable = [
  { kind: "comment", tone: "comment", fontStyle: "italic" },
  { kind: "tag", tone: "keyword-control", fontStyle: "" },
  { kind: "keyword", tone: "keyword", fontStyle: "bold" },
  { kind: "keyword-control", tone: "keyword-control", fontStyle: "bold" },
  { kind: "title", tone: "text", fontStyle: "bold" },
  { kind: "type", tone: "type", fontStyle: "" },
  { kind: "verb", tone: "verb", fontStyle: "" },
  { kind: "string", tone: "string", fontStyle: "" },
  { kind: "number", tone: "number", fontStyle: "" },
  { kind: "delimiter", tone: "table-line", fontStyle: "" },
  { kind: "table-header", tone: "table-header", fontStyle: "bold" },
  { kind: "table-cell", tone: "text", fontStyle: "" },
  { kind: "function", tone: "keyword-control", fontStyle: "" },
  { kind: "root", tone: "keyword", fontStyle: "bold" },
  { kind: "operator", tone: "verb", fontStyle: "" },
  { kind: "variable", tone: "number", fontStyle: "italic" },
] as const;

export type HighlightTokenDefinition = (typeof highlightTokenTable)[number];
export type HighlightTokenKind = HighlightTokenDefinition["kind"];
export type HighlightTokenTone = HighlightTokenDefinition["tone"];
export type HighlightKind = HighlightTokenKind | "";
export interface HighlightToken { readonly text: string; readonly cls: HighlightKind }
export type HighlightLine = HighlightToken[];
export interface HighlightVocabulary {
  readonly roots?: readonly string[];
  readonly functions?: readonly string[];
  readonly types?: readonly string[];
  readonly verbs?: readonly string[];
}

interface Span { readonly start: number; readonly end: number; readonly cls: HighlightKind }

export function highlightGherkinSource(source: string, vocabulary: HighlightVocabulary = {}): HighlightLine[] {
  const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
  const spans = lines.map(() => [] as Span[]);
  highlightPhysicalLines(lines, spans, vocabulary);
  const document = parsed(source);
  if (document?.feature) {
    mark(spans, document.feature.location.line, document.feature.location.column ?? 1, document.feature.keyword.length, "keyword-control");
    markAfter(lines, spans, document.feature.location.line, ":", "title");
    for (const tag of document.feature.tags) mark(spans, tag.location.line, tag.location.column ?? 1, tag.name.length, "tag");
    for (const child of document.feature.children) {
      const node = child.background ?? child.scenario ?? child.rule;
      if (!node) continue;
      mark(spans, node.location.line, node.location.column ?? 1, node.keyword.length, "keyword-control");
      markAfter(lines, spans, node.location.line, ":", "title");
      if (child.scenario) for (const tag of child.scenario.tags) mark(spans, tag.location.line, tag.location.column ?? 1, tag.name.length, "tag");
      for (const step of child.background?.steps ?? child.scenario?.steps ?? []) highlightStep(lines, spans, step, vocabulary);
    }
  }
  return lines.map((line, index) => lineTokens(line, spans[index]!));
}

export function highlightExpressionSource(source: string, vocabulary: HighlightVocabulary = {}): HighlightLine[] {
  const value = source.endsWith("\n") ? source.slice(0, -1) : source;
  return value.split("\n").map((line) => expressionLine(line, vocabulary));
}

function highlightStep(lines: readonly string[], spans: Span[][], step: Step, vocabulary: HighlightVocabulary): void {
  const keyword = step.keyword.trim();
  mark(spans, step.location.line, step.location.column ?? 1, keyword.length, "keyword");
  const sentenceColumn = (step.location.column ?? 1) + step.keyword.length;
  try {
    const physicalSentence = lines[step.location.line - 1]?.slice(sentenceColumn - 1) ?? step.text;
    for (const token of tokenizeSentence(physicalSentence)) {
      const cls = token.kind === "quoted" ? "string"
        : vocabulary.types?.includes(token.value) ? "type"
          : vocabulary.verbs?.includes(token.value) ? "verb" : "";
      if (cls) mark(spans, step.location.line, sentenceColumn + token.start, token.end - token.start, cls);
    }
  } catch { /* the compiler diagnostic owns malformed sentences */ }
  for (const [rowIndex, row] of (step.dataTable?.rows ?? []).entries()) for (const cell of row.cells) {
    mark(spans, cell.location.line, cell.location.column ?? 1, cell.value.length, rowIndex === 0 ? "table-header" : "table-cell");
  }
  const doc = step.docString;
  if (!doc) return;
  const fenceLine = doc.location.line;
  mark(spans, fenceLine, doc.location.column ?? 1, (lines[fenceLine - 1]?.trim().length ?? 3), "string");
  const expression = highlightExpressionSource(doc.content, vocabulary);
  expression.forEach((tokens, offset) => {
    let column = (doc.location.column ?? 1) - 1;
    for (const token of tokens) {
      if (token.cls) mark(spans, fenceLine + offset + 1, column + 1, token.text.length, token.cls);
      column += token.text.length;
    }
  });
  const closeLine = fenceLine + expression.length + 1;
  mark(spans, closeLine, doc.location.column ?? 1, (lines[closeLine - 1]?.trim().length ?? 3), "string");
}

/** Lexical colour for incomplete documents and physical continuation lines. The AST pass below adds
    structural precision when parsing succeeds; this pass keeps authoring useful while the source is partial. */
function highlightPhysicalLines(lines: readonly string[], spans: Span[][], vocabulary: HighlightVocabulary): void {
  let docString: '"""' | '```' | undefined;
  let previousWasTable = false;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const first = line.trimStart();
    const column = line.length - first.length + 1;

    if (docString !== undefined) {
      if (first.startsWith(docString)) {
        mark(spans, lineNumber, column, first.length, "string");
        docString = undefined;
      } else {
        markExpressionLine(spans, lineNumber, line, vocabulary);
      }
      previousWasTable = false;
      return;
    }
    const docStringStart = first.startsWith('"""') ? '"""' : first.startsWith('```') ? '```' : undefined;
    if (docStringStart !== undefined) {
      mark(spans, lineNumber, column, first.length, "string");
      docString = docStringStart;
      previousWasTable = false;
      return;
    }
    if (first.startsWith("#")) {
      mark(spans, lineNumber, column, first.length, "comment");
      previousWasTable = false;
      return;
    }
    if (first.startsWith("|")) {
      markTableLine(spans, lineNumber, line, !previousWasTable);
      previousWasTable = true;
      return;
    }
    previousWasTable = false;

    if (first.startsWith("@")) {
      const tagPrefix = /^@[^\s]+(?:\s+@[^\s]+)*/.exec(first)?.[0] ?? "";
      for (const tag of tagPrefix.matchAll(/@[^\s]+/g)) mark(spans, lineNumber, column + (tag.index ?? 0), tag[0].length, "tag");
      return;
    }

    const heading = /^(\s*)(Feature|Background|Scenario Outline|Scenario|Rule|Examples)\s*:/.exec(line);
    if (heading) {
      const keyword = heading[2]!;
      mark(spans, lineNumber, heading[1]!.length + 1, keyword.length, "keyword-control");
      markAfter(lines, spans, lineNumber, ":", "title");
      return;
    }

    const step = /^(\s*)((?:Given|When|Then|And|But)(?:[|/](?:Given|When|Then|And|But))*)(?=\s)/.exec(line);
    if (step) {
      const start = step[1]!.length;
      for (const keyword of step[2]!.matchAll(/Given|When|Then|And|But/g)) {
        mark(spans, lineNumber, start + (keyword.index ?? 0) + 1, keyword[0].length, "keyword");
      }
      markSentenceTokens(spans, lineNumber, line.slice(step[0].length), step[0].length + 1, vocabulary);
      return;
    }

    // Indented continuation lines and grammar synopsis placeholders have no standalone AST node.
    markSentenceTokens(spans, lineNumber, line, 1, vocabulary);
  });
}

function markSentenceTokens(spans: Span[][], line: number, sentence: string, column: number, vocabulary: HighlightVocabulary): void {
  try {
    for (const token of tokenizeSentence(sentence)) {
      const cls = token.kind === "quoted" ? "string"
        : vocabulary.types?.includes(token.value) ? "type"
          : vocabulary.verbs?.includes(token.value) ? "verb" : "";
      if (cls) mark(spans, line, column + token.start, token.end - token.start, cls);
    }
  } catch { /* partial sentences still receive the structural and placeholder tokens below */ }
  for (const placeholder of sentence.matchAll(/<[^>]+>/g)) mark(spans, line, column + (placeholder.index ?? 0), placeholder[0].length, "variable");
  for (const number of sentence.matchAll(/\b\d+(?:\.\d+)*\b/g)) mark(spans, line, column + (number.index ?? 0), number[0].length, "number");
}

function markExpressionLine(spans: Span[][], line: number, source: string, vocabulary: HighlightVocabulary): void {
  let column = 1;
  for (const token of expressionLine(source, vocabulary)) {
    if (token.cls) mark(spans, line, column, token.text.length, token.cls);
    column += token.text.length;
  }
}

function markTableLine(spans: Span[][], lineNumber: number, line: string, header: boolean): void {
  const bars = Array.from(line.matchAll(/\|/g), (match) => match.index ?? 0);
  for (const bar of bars) mark(spans, lineNumber, bar + 1, 1, "delimiter");
  for (let index = 0; index + 1 < bars.length; index += 1) {
    const start = bars[index]! + 1;
    const end = bars[index + 1]!;
    const raw = line.slice(start, end);
    const left = raw.length - raw.trimStart().length;
    const value = raw.trim();
    if (value) mark(spans, lineNumber, start + left + 1, value.length, header ? "table-header" : "table-cell");
  }
}

function expressionLine(line: string, vocabulary: HighlightVocabulary): HighlightLine {
  const tokens: HighlightLine = [];
  let at = 0;
  while (at < line.length) {
    const start = at;
    const character = line[at]!;
    let cls: HighlightKind = "";
    if (character === '"' || character === "'" || character === "`") {
      at += 1;
      while (at < line.length && (line[at] !== character || line[at - 1] === "\\")) at += 1;
      at += Number(at < line.length);
      cls = "string";
    } else if (digit(character)) {
      while (at < line.length && (digit(line[at]!) || line[at] === ".")) at += 1;
      cls = "number";
    } else if (isExpressionIdentifierStart(character)) {
      at += 1;
      while (at < line.length && isExpressionIdentifierPart(line[at]!)) at += 1;
      const word = line.slice(start, at);
      cls = vocabulary.functions?.includes(word) || vocabulary.functions?.includes(word.slice(1)) ? "function"
        : vocabulary.roots?.includes(word) ? "root" : "variable";
    } else if ("?:=<>!&|+-*/%".includes(character)) {
      while (at < line.length && "?:=<>!&|+-*/%".includes(line[at]!)) at += 1;
      cls = "operator";
    } else {
      at += 1;
      cls = "{}[](),.;".includes(character) ? "delimiter" : "";
    }
    tokens.push({ text: line.slice(start, at), cls });
  }
  return tokens;
}

function parsed(source: string): GherkinDocument | undefined {
  try { return parseGherkin(source); } catch (error) {
    if (error instanceof GherkinSyntaxError) return undefined;
    throw error;
  }
}

function mark(spans: Span[][], line: number, column: number, length: number, cls: HighlightKind): void {
  if (length > 0) spans[line - 1]?.push({ start: column - 1, end: column - 1 + length, cls });
}

function markAfter(lines: readonly string[], spans: Span[][], line: number, delimiter: string, cls: HighlightKind): void {
  const text = lines[line - 1] ?? "";
  const start = text.indexOf(delimiter);
  if (start >= 0 && start + 1 < text.length) spans[line - 1]?.push({ start: start + 1, end: text.length, cls });
}

function lineTokens(line: string, values: readonly Span[]): HighlightLine {
  const tokens: HighlightLine = [];
  let at = 0;
  for (const span of [...values].sort((left, right) => left.start - right.start || right.end - left.end)) {
    if (span.start < at) continue;
    if (span.start > at) tokens.push({ text: line.slice(at, span.start), cls: "" });
    tokens.push({ text: line.slice(span.start, span.end), cls: span.cls });
    at = span.end;
  }
  if (at < line.length || tokens.length === 0) tokens.push({ text: line.slice(at), cls: "" });
  return tokens;
}

const digit = (character: string): boolean => character >= "0" && character <= "9";
