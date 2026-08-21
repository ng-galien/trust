import type { GherkinDocument, Step } from "@cucumber/messages";

import { GherkinSyntaxError, parseGherkin } from "./document.js";
import { isExpressionIdentifierPart, isExpressionIdentifierStart, tokenizeSentence } from "./sentence.js";

export type HighlightKind = "comment" | "tag" | "keyword" | "keyword-control" | "title" | "type" | "verb" | "string" | "number" | "delimiter" | "table-header" | "table-cell" | "function" | "root" | "operator" | "variable" | "";
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
  lines.forEach((line, index) => {
    const first = line.trimStart();
    if (first.startsWith("#")) mark(spans, index + 1, line.length - first.length + 1, first.length, "comment");
  });
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
    for (const token of tokenizeSentence(step.text)) {
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
