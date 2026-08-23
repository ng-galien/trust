import {
  CompletionItemKind,
  DiagnosticSeverity,
  DocumentSymbol,
  FoldingRangeKind,
  SymbolKind,
  SemanticTokensBuilder,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem,
  type Connection,
  type Diagnostic,
  type FoldingRange,
  type InitializeResult,
  type Position,
  type Range,
  type TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { GherkinDocument, Step } from "@cucumber/messages";

import { GherkinSyntaxError, highlightGherkinSource, isExpressionIdentifierPart, parseGherkin, tokenizeSentence, type HighlightKind, type SentenceToken } from "@trust/gherkin";
import { formatGherkinSource } from "@trust/gherkin/format";
import {
  analyzeOperation,
  isOperationSource,
  type CompiledOperation,
  type OperationDocument,
  type SourceRange,
} from "@trust/operation";
import { operationAuthoringSnippets, operationHighlightVocabulary, operationLanguage } from "@trust/operation/language";
import { analyzeProcedure, isProcedureSource, transitiveScenarioDependencies, type CompiledProcedure } from "@trust/procedure";
import { expressionMember, procedureHighlightVocabulary, procedureLanguage, qualificationCompletionPath, type QualificationCompletionPath } from "@trust/procedure/language";

type LanguageKind = "operation" | "procedure";
const semanticTokenTypes = ["comment", "keyword", "string", "number", "operator", "type", "variable", "function", "property"] as const;

export interface TrustLanguageServerOptions {
  readonly operations?: () => readonly CompiledOperation[];
}

/** Install the TRUST language on one connection. Stdio and WebSocket use these exact handlers. */
export function startTrustLanguageServer(
  connection: Connection,
  options: TrustLanguageServerOptions = {},
): void {
  const documents = new TextDocuments(TextDocument);
  const documentKinds = new Map<string, LanguageKind>();
  const openOperations = new Map<string, CompiledOperation>();
  const catalog = (): readonly CompiledOperation[] => {
    const byName = new Map<string, CompiledOperation>();
    for (const operation of options.operations?.() ?? []) byName.set(operation.operation, operation);
    for (const operation of openOperations.values()) byName.set(operation.operation, operation);
    return [...byName.values()];
  };

  connection.onInitialize((): InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        completionProvider: { triggerCharacters: [" ", '"', ".", "$", "@"] },
        foldingRangeProvider: true,
        semanticTokensProvider: { legend: { tokenTypes: [...semanticTokenTypes], tokenModifiers: [] }, full: true },
      },
    };
  });

  const update = (document: TextDocument) => {
    const kind = documentKind(document) ?? documentKinds.get(document.uri);
    if (kind) documentKinds.set(document.uri, kind);
    if (kind === "operation") {
      const analysis = analyzeOperation({ source: document.getText(), sourceName: document.uri });
      if ("compiled" in analysis) openOperations.set(document.uri, analysis.compiled);
      else openOperations.delete(document.uri);
    }
    publishDiagnostics(document);
  };

  documents.onDidOpen(({ document }) => update(document));
  documents.onDidChangeContent(({ document }) => update(document));
  documents.onDidClose(({ document }) => {
    documentKinds.delete(document.uri);
    openOperations.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: [] });
  });

  connection.onDocumentFormatting(({ textDocument }): TextEdit[] => {
    const document = documents.get(textDocument.uri);
    if (!document) return [];
    const source = document.getText();
    const formatted = formatGherkinSource(source);
    return formatted === source ? [] : [{ range: { start: { line: 0, character: 0 }, end: document.positionAt(source.length) }, newText: formatted }];
  });

  connection.onFoldingRanges(({ textDocument }): FoldingRange[] => {
    const document = documents.get(textDocument.uri);
    return document ? foldingRanges(document.getText()) : [];
  });

  connection.onCompletion(({ textDocument, position }): CompletionItem[] => {
    const document = documents.get(textDocument.uri);
    if (!document) return [];
    const kind = documentKinds.get(document.uri) ?? documentKind(document);
    return kind ? completionItems(document, position, kind, catalog()) : [];
  });

  connection.languages.semanticTokens.on(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    return document ? semanticTokens(document.getText()) : null;
  });

  connection.onDocumentSymbol(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    if (!document) return [];
    const kind = documentKinds.get(document.uri) ?? documentKind(document);
    if (kind === "operation") {
      const analysis = analyzeOperation({ source: document.getText(), sourceName: document.uri });
      if (!analysis.document) return [];
      return operationSymbols(analysis.document);
    }
    return kind === "procedure" ? procedureSymbols(document, catalog()) : [];
  });

  function publishDiagnostics(document: TextDocument): void {
    const kind = documentKinds.get(document.uri);
    let diagnostics: Diagnostic[] = [];
    if (kind === "operation") {
      diagnostics = analyzeOperation({ source: document.getText(), sourceName: document.uri }).diagnostics.map((diagnostic) => ({
        severity: DiagnosticSeverity.Error,
        range: lspRange(diagnostic.range),
        message: diagnostic.message,
        code: diagnostic.code,
        source: "trust-operation",
      }));
    } else if (kind === "procedure") {
      diagnostics = analyzeProcedure({ source: document.getText(), sourceName: document.uri, operations: catalog() }).diagnostics.map((diagnostic) => ({
          severity: DiagnosticSeverity.Error,
          range: diagnosticRange(document, diagnostic.location),
          message: diagnostic.message,
          code: diagnostic.code,
          source: "trust-procedure",
      }));
    }
    connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics });
  }

  documents.listen(connection);
  connection.listen();
}

function sourceKind(source: string): LanguageKind | undefined {
  if (isOperationSource(source)) return "operation";
  if (isProcedureSource(source)) return "procedure";
  return undefined;
}

function documentKind(document: TextDocument): LanguageKind | undefined {
  return sourceKind(document.getText())
    ?? (document.languageId === "trust-operation" ? "operation" : document.languageId === "trust-procedure" ? "procedure" : undefined);
}

function semanticTokens(source: string) {
  const vocabulary = sourceKind(source) === "operation" ? operationHighlightVocabulary : procedureHighlightVocabulary;
  const builder = new SemanticTokensBuilder();
  highlightGherkinSource(source, vocabulary).forEach((tokens, line) => {
    let character = 0;
    for (const token of tokens) {
      const type = semanticType(token.cls);
      if (type !== undefined && token.text.length > 0) builder.push(line, character, token.text.length, type, 0);
      character += token.text.length;
    }
  });
  return builder.build();
}

function semanticType(kind: HighlightKind): number | undefined {
  const type = kind === "comment" ? "comment"
    : kind === "keyword" || kind === "keyword-control" || kind === "verb" ? "keyword"
      : kind === "string" || kind === "title" ? "string"
        : kind === "number" ? "number"
          : kind === "operator" || kind === "delimiter" ? "operator"
            : kind === "type" || kind === "root" ? "type"
              : kind === "function" ? "function"
                : kind === "table-header" ? "property"
                  : kind === "variable" || kind === "tag" || kind === "table-cell" ? "variable" : undefined;
  return type === undefined ? undefined : semanticTokenTypes.indexOf(type);
}

function completionItems(document: TextDocument, position: Position, kind: LanguageKind, operations: readonly CompiledOperation[]): CompletionItem[] {
  const source = document.getText();
  const offset = document.offsetAt(position);
  const embedded = embeddedLanguageAt(source, position.line + 1);
  if (embedded === "js") return jsCompletions(document, position, operations);
  if (embedded === "jsonata") return jsonataCompletions(document, position);
  return kind === "procedure"
    ? procedureCompletions(source, position.line + 1, position.character, operations)
    : operationCompletions(source);
}

function procedureCompletions(source: string, line: number, character: number, operations: readonly CompiledOperation[]): CompletionItem[] {
  const tokens = stepTokensAt(source, line);
  const words = tokens.filter((token) => token.kind === "text").map((token) => token.value);
  const physicalLine = source.split(/\r?\n/)[line - 1] ?? "";
  const prefix = physicalLine.slice(0, character);
  const suffix = physicalLine.slice(character);
  const model = compileProcedureModel(source, operations);
  const selectedOperation = operationForCheck(tokens, operations);
  if (words.includes("Operation")) return operations.map((operation) => item(operation.operation, CompletionItemKind.Module, operation.title));
  if (words.includes("Input") && selectedOperation) {
    return Object.keys(selectedOperation.input.properties).map((name) => item(name, CompletionItemKind.Property, "Operation input"));
  }
  if (words.includes("on") || words.includes("using")) {
    return (model?.roles ?? []).map((role) => item(role.name, CompletionItemKind.Variable, "Plan context role"));
  }
  if (words[0] === procedureLanguage.phrases.dependency) return (model?.scenarios ?? []).map((scenario) => item(scenario.slug, CompletionItemKind.Event, "Prerequisite Scenario"));
  if (words.includes("field") && selectedOperation) {
    return Object.keys(selectedOperation.produced.properties).map((name) => item(name, CompletionItemKind.Field, "Produced Fact field"));
  }
  if (/\bdeclared\s+$/.test(prefix) && words.includes("declared") && !words.includes("optionally")) {
    return [{
      ...item("optionally", CompletionItemKind.Keyword, "Optional agent declaration"),
      insertText: /^\s*by\s+agent\b/.test(suffix) ? "optionally " : "optionally by agent",
    }];
  }
  return [
    snippet("Procedure feature", procedureLanguage.template),
  ];
}

function operationCompletions(source: string): CompletionItem[] {
  const document = analyzeOperation({ source }).document;
  return [
    ...(document?.environment ?? []).map((field) => item(field.name, CompletionItemKind.Variable, "Operation environment")),
    ...(document?.input ?? []).map((field) => item(field.name, CompletionItemKind.Variable, "Operation input")),
    ...operationLanguage.environmentTypes.map((type) => item(type, CompletionItemKind.TypeParameter, "Environment type")),
    ...operationLanguage.valueTypes.map((type) => item(type, CompletionItemKind.TypeParameter, "Operation value type")),
    ...operationLanguage.cardinalities.map((cardinality) => item(cardinality, CompletionItemKind.EnumMember, "Cardinality")),
    ...operationLanguage.formats.map((format) => item(format, CompletionItemKind.EnumMember, "Operation format")),
    ...operationAuthoringSnippets.map(({ label, insertText }) => snippet(label, insertText)),
    snippet("Operation feature", operationLanguage.template),
  ];
}

function jsCompletions(document: TextDocument, position: Position, operations: readonly CompiledOperation[]): CompletionItem[] {
  const source = document.getText();
  const path = qualificationCompletionPath(source, document.offsetAt(position));
  const model = compileProcedureModel(source, operations);
  const currentCheck = checkAt(source, position.line + 1, model);
  const operation = operations.find((candidate) => candidate.operation === currentCheck?.operation);
  const roots = procedureLanguage.qualification.roots;
  if (path?.root === roots.fact) {
    return operation ? Object.entries(operation.produced.properties).map(([name, schema]) => memberItem(document, name, CompletionItemKind.Field, schemaDescription(schema), path, position)) : [];
  }
  if (path?.root === roots.context) return (model?.roles ?? []).map((role) => memberItem(document, role.name, CompletionItemKind.Variable, "Typed Plan context role", path, position));
  if (path?.root === roots.checks) {
    const checkName = path.members[0];
    if (checkName) {
      const referenced = model?.checks.find((entry) => entry.name === checkName);
      const provider = operations.find((candidate) => candidate.operation === referenced?.operation);
      return provider ? Object.entries(provider.produced.properties).map(([name, schema]) => memberItem(document, name, CompletionItemKind.Field, schemaDescription(schema), path, position)) : [];
    }
    return prerequisiteChecks(model, currentCheck?.scenario).map((entry) => memberItem(document, entry.name, CompletionItemKind.Variable, `Check using ${entry.operation}`, path, position));
  }
  const mathRoot = procedureLanguage.qualification.roots.math;
  if (path?.root === mathRoot) return Object.keys(procedureLanguage.qualification.mathFunctions).map((name) => memberItem(document, name, CompletionItemKind.Function, "Supported numeric function", path, position));
  return [
    item(procedureLanguage.qualification.roots.fact, CompletionItemKind.Variable, "Fields produced by this Check's Operation"),
    item(procedureLanguage.qualification.roots.context, CompletionItemKind.Variable, "Typed Plan context"),
    item(procedureLanguage.qualification.roots.checks, CompletionItemKind.Variable, "Facts from prerequisite Checks"),
    item(mathRoot, CompletionItemKind.Class, "Supported numeric functions"),
    snippet(procedureLanguage.qualification.fail, procedureLanguage.qualification.fail + '("${1:reason}")'),
  ];
}

function jsonataCompletions(document: TextDocument, position: Position): CompletionItem[] {
  const source = document.getText();
  const path = identifierPathBefore(source, document.offsetAt(position));
  const model = analyzeOperation({ source }).document;
  const [stepsRoot, inputRoot, environmentRoot] = operationLanguage.jsonata.roots;
  if (path === stepsRoot || path === `${stepsRoot}.`) return (model?.steps ?? []).map(({ name }) => item(name, CompletionItemKind.Variable, "Operation step result"));
  const stepPath = path.split(".");
  if (stepPath[0] === stepsRoot && stepPath.length >= 3) {
    const step = model?.steps.find(({ name }) => name === stepPath[1]);
    const fields = step ? operationLanguage.stepResults[step.type] : [];
    return fields.map((name) => item(name, CompletionItemKind.Property, `${step?.type ?? "Operation"} step result`));
  }
  if (path === inputRoot || path.startsWith(`${inputRoot}.`)) return (model?.input ?? []).map(({ name }) => item(name, CompletionItemKind.Property, "Operation input"));
  if (path === environmentRoot || path.startsWith(`${environmentRoot}.`)) return (model?.environment ?? []).map(({ name }) => item(name, CompletionItemKind.Property, "Operation environment"));
  return [
    item(stepsRoot, CompletionItemKind.Variable, "Results of named Operation steps"),
    item(inputRoot, CompletionItemKind.Variable, "Typed Operation input"),
    item(environmentRoot, CompletionItemKind.Variable, "Operation environment"),
    ...operationLanguage.jsonata.functions.map((name) => item(`$${name}`, CompletionItemKind.Function, "JSONata built-in function")),
  ];
}

function embeddedLanguageAt(source: string, line: number): "js" | "jsonata" | undefined {
  const step = allSteps(parseSource(source)).find((candidate) => {
    const start = candidate.docString?.location?.line;
    const length = candidate.docString?.content.split("\n").length ?? 0;
    return start !== undefined && line > start && line <= start + length;
  });
  if (!step?.docString) return undefined;
  return step.docString.mediaType === procedureLanguage.qualification.mediaType
    ? "js"
    : step.text === operationLanguage.phrases.produce ? "jsonata" : undefined;
}

function compileProcedureModel(source: string, operations: readonly CompiledOperation[]): CompiledProcedure | undefined {
  return analyzeProcedure({ source, operations }).compiled;
}

function operationForCheck(tokens: readonly SentenceToken[], operations: readonly CompiledOperation[]): CompiledOperation | undefined {
  const quoted = tokens.filter((token) => token.kind === "quoted");
  return operations.find((operation) => operation.operation === quoted[1]?.value);
}

function checkAt(source: string, line: number, model: CompiledProcedure | undefined) {
  const name = stepTokensAt(source, line).find((token) => token.kind === "quoted")?.value;
  return model?.checks.find((check) => check.name === name);
}

function prerequisiteChecks(model: CompiledProcedure | undefined, scenario: string | undefined) {
  if (!model || !scenario) return [];
  const slugs = transitiveScenarioDependencies(scenario, model.scenarios);
  return model.checks.filter((check) => slugs.has(check.scenario));
}

function identifierPathBefore(source: string, offset: number): string {
  let start = offset;
  while (start > 0 && identifierPathCharacter(source[start - 1]!)) start -= 1;
  return source.slice(start, offset);
}

function identifierPathCharacter(character: string): boolean {
  return character === "." || isExpressionIdentifierPart(character);
}

function schemaDescription(schema: { type?: unknown; items?: { type?: unknown } }): string {
  return schema.type === "array" ? `${String(schema.items?.type ?? "value")}[]` : String(schema.type ?? "value");
}

function item(label: string, kind: CompletionItemKind, detail: string): CompletionItem { return { label, kind, detail }; }
function snippet(label: string, insertText: string): CompletionItem { return { label, kind: CompletionItemKind.Snippet, insertText, insertTextFormat: 2 }; }
function memberItem(document: TextDocument, label: string, kind: CompletionItemKind, detail: string, path: QualificationCompletionPath, position: Position): CompletionItem {
  const member = expressionMember(label);
  const source = document.getText();
  const hasDot = source[path.replaceOffset - 1] === ".";
  const startOffset = hasDot && member.startsWith("[") ? path.replaceOffset - 1 : path.replaceOffset;
  const start = document.positionAt(startOffset);
  return {
    label, kind, detail,
    textEdit: {
      range: { start, end: position },
      newText: hasDot && member.startsWith(".") ? member.slice(1) : member,
    },
  };
}

function foldingRanges(source: string): FoldingRange[] {
  const parsed = parseSource(source);
  const children = parsed?.feature?.children ?? [];
  const lastLine = source.split("\n").length - 1;
  const ranges: FoldingRange[] = [];
  for (const [index, child] of children.entries()) {
    const node = child.background ?? child.scenario ?? child.rule;
    const start = (node?.location.line ?? 1) - 1;
    const end = (children[index + 1]?.background ?? children[index + 1]?.scenario ?? children[index + 1]?.rule)?.location.line;
    if ((end ?? lastLine + 1) > start + 1) ranges.push({ startLine: start, endLine: (end ?? lastLine + 1) - 2, kind: FoldingRangeKind.Region });
  }
  for (const step of allSteps(parsed)) {
    const start = step.docString?.location?.line;
    const length = step.docString?.content.split("\n").length ?? 0;
    if (start !== undefined && length > 1) ranges.push({ startLine: start - 1, endLine: start + length, kind: FoldingRangeKind.Region });
  }
  return ranges;
}

function procedureSymbols(document: TextDocument, operations: readonly CompiledOperation[]): DocumentSymbol[] {
  const source = document.getText();
  const model = compileProcedureModel(source, operations);
  const parsed = parseSource(source);
  if (!model || !parsed?.feature) return [];
  const rootRange = { start: { line: 0, character: 0 }, end: document.positionAt(source.length) };
  const children: DocumentSymbol[] = [];
  const lines = source.split("\n");
  for (const child of parsed.feature.children) {
    if (child.background) for (const step of child.background.steps) {
      const role = stepTokens(step).find((token) => token.kind === "quoted")?.value;
      if (!role || !model.roles.some((candidate) => candidate.name === role)) continue;
      const range = lineTextRange(step.location.line - 1, lines[step.location.line - 1] ?? "");
      children.push(DocumentSymbol.create(role, "Context role", SymbolKind.Variable, range, range));
    }
    if (!child.scenario) continue;
    const scenarioRange = lineTextRange(child.scenario.location.line - 1, lines[child.scenario.location.line - 1] ?? "");
    children.push(DocumentSymbol.create(child.scenario.name, "Scenario", SymbolKind.Event, scenarioRange, scenarioRange));
    for (const step of child.scenario.steps) {
      const name = stepTokens(step).find((token) => token.kind === "quoted")?.value;
      if (!name || !model.checks.some((check) => check.name === name)) continue;
      const range = lineTextRange(step.location.line - 1, lines[step.location.line - 1] ?? "");
      children.push(DocumentSymbol.create(name, "Check", SymbolKind.Function, range, range));
    }
  }
  return [DocumentSymbol.create(model.procedure, "Procedure", SymbolKind.Module, rootRange, rootRange, children)];
}

function parseSource(source: string): GherkinDocument | undefined {
  try { return parseGherkin(source); } catch (error) {
    if (error instanceof GherkinSyntaxError) return undefined;
    throw error;
  }
}

function allSteps(document: GherkinDocument | undefined): readonly Step[] {
  return document?.feature?.children.flatMap((child) => child.background?.steps ?? child.scenario?.steps ?? child.rule?.children.flatMap((nested) => nested.background?.steps ?? nested.scenario?.steps ?? []) ?? []) ?? [];
}

function stepTokensAt(source: string, line: number): readonly SentenceToken[] {
  const step = allSteps(parseSource(source)).find((candidate) => {
    if (candidate.location.line === line) return true;
    const start = candidate.docString?.location?.line;
    const length = candidate.docString?.content.split("\n").length ?? 0;
    return start !== undefined && line > start && line <= start + length;
  });
  return step ? stepTokens(step) : [];
}

function stepTokens(step: Step): readonly SentenceToken[] {
  try { return tokenizeSentence(step.text); } catch { return []; }
}

function operationSymbols(document: OperationDocument): DocumentSymbol[] {
  const children: DocumentSymbol[] = [
    ...document.environment.map((field) => DocumentSymbol.create(field.name, `Environment: ${field.type}`, SymbolKind.Variable, lspRange(field.range), lspRange(field.selectionRange))),
    ...document.input.map((field) => DocumentSymbol.create(field.name, `Input: ${field.type} ${field.cardinality}`, SymbolKind.Property, lspRange(field.range), lspRange(field.selectionRange))),
    ...document.steps.map((step) => DocumentSymbol.create(step.name, `Step: ${step.type}`, SymbolKind.Function, lspRange(step.range), lspRange(step.selectionRange))),
    ...document.produced.map((field) => DocumentSymbol.create(field.name, `Produced: ${field.type} ${field.cardinality}`, SymbolKind.Field, lspRange(field.range), lspRange(field.selectionRange))),
  ];
  const firstLine = document.description?.split("\n").find((line) => line.trim() !== "")?.trim();
  return [DocumentSymbol.create(document.operation ?? document.title, `${document.version ? `Operation ${document.version}` : "Operation"}${firstLine ? ` — ${firstLine}` : ""}`, SymbolKind.Module, lspRange(document.range), lspRange(document.selectionRange), children)];
}

function diagnosticRange(document: TextDocument, location?: { readonly line: number; readonly column: number }): Range {
  if (!location) return lineTextRange(0, document.getText().split("\n")[0] ?? "");
  const line = Math.max(0, Math.min(document.lineCount - 1, location.line - 1));
  const text = document.getText({ start: { line, character: 0 }, end: line + 1 < document.lineCount ? { line: line + 1, character: 0 } : document.positionAt(document.getText().length) }).split("\n")[0] ?? "";
  const start = Math.max(0, Math.min(text.length, location.column - 1));
  return { start: { line, character: start }, end: { line, character: Math.max(start + 1, text.length) } };
}

function lineTextRange(line: number, text: string): Range { return { start: { line, character: 0 }, end: { line, character: Math.max(1, text.length) } }; }
function lspRange(range: SourceRange): Range { return { start: { line: range.start.line - 1, character: range.start.column - 1 }, end: { line: range.end.line - 1, character: range.end.column - 1 } }; }
