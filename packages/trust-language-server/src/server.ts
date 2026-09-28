import type { GherkinDocument, Step, TableRow } from "@cucumber/messages";
import { type TemplateDocumentContext, templateDocumentContextMethod } from "@trust/extension-sdk";
import {
  continuationLineIndexes,
  GherkinSyntaxError,
  highlightGherkinSource,
  highlightTokenTable,
  isExpressionIdentifierPart,
  joinContinuations,
  parseGherkin,
  SentenceSyntaxError,
  type SentenceToken,
  type StepGrammarExpectation,
  splitLines,
  stepGrammarExpectations,
  tokenizeSentence,
} from "@trust/gherkin";
import { formatGherkinSource } from "@trust/gherkin/format";
import {
  analyzeOperation,
  type CompiledOperation,
  isOperationSource,
  type OperationDocument,
  type SourceRange,
} from "@trust/operation";
import {
  operationAuthoringSnippets,
  operationHighlightVocabulary,
  operationLanguage,
  operationStepGrammar,
} from "@trust/operation/language";
import {
  analyzeProcedure,
  analyzeProcedureScopeFragment,
  type CompiledProcedure,
  isProcedureSource,
  transitiveScenarioDependencies,
} from "@trust/procedure";
import {
  expressionMember,
  procedureHighlightVocabulary,
  procedureLanguage,
  procedureStepGrammar,
  type QualificationCompletionPath,
  qualificationCompletionPath,
} from "@trust/procedure/language";
import {
  type CompletionItem,
  CompletionItemKind,
  type Connection,
  type Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  type FoldingRange,
  FoldingRangeKind,
  type InitializeResult,
  type Position,
  type PublishDiagnosticsParams,
  type Range,
  SemanticTokensBuilder,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  type TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { resourceReferences } from "./references.js";
import { templateContext, templateProjection } from "./template-context.js";

type LanguageKind = "operation" | "procedure";
const semanticTokenTypes = highlightTokenTable.map(({ kind }) => kind);
const semanticTokenIndexes = new Map(semanticTokenTypes.map((kind, index) => [kind, index]));

export interface TrustLanguageServerOptions {
  readonly operations?: () => readonly CompiledOperation[];
  readonly procedures?: () => readonly CompiledProcedure[] | Promise<readonly CompiledProcedure[]>;
  readonly connectionActive?: () => boolean;
}

/** Install the TRUST language on one connection. Stdio and WebSocket use these exact handlers. */
export function startTrustLanguageServer(connection: Connection, options: TrustLanguageServerOptions = {}): void {
  const documents = new TextDocuments(TextDocument);
  const invalidTemplateContexts = new Set<string>();
  const templateContexts = new Map<string, TemplateDocumentContext>();
  const projections = new WeakMap<
    TextDocument,
    { parameters: TemplateDocumentContext; version: number; view: ReturnType<typeof templateProjection> }
  >();
  const projection = (document: TextDocument) => {
    const parameters = templateContexts.get(document.uri);
    if (!parameters) return undefined;
    const cached = projections.get(document);
    if (cached?.parameters === parameters && cached.version === document.version) return cached.view;
    const view = templateProjection(document, parameters);
    projections.set(document, { parameters, version: document.version, view });
    return view;
  };
  const authoringDocument = (document: TextDocument) => projection(document)?.document ?? document;
  const kindOf = (document: TextDocument) => {
    const view = projection(document);
    return view
      ? view.fragment
        ? ("procedure" as const)
        : sourceKind(view.document.getText())
      : (documentKinds.get(document.uri) ?? documentKind(document));
  };
  const documentKinds = new Map<string, LanguageKind>();
  const openOperations = new Map<string, CompiledOperation>();
  const sendDiagnostics = (params: PublishDiagnosticsParams): void => {
    if (options.connectionActive?.() === false) return;
    connection.sendDiagnostics(params);
  };
  const catalog = (): readonly CompiledOperation[] => {
    const byName = new Map<string, CompiledOperation>();
    for (const operation of options.operations?.() ?? [])
      byName.set(`${operation.operation}@${operation.version}`, operation);
    for (const operation of openOperations.values())
      byName.set(`${operation.operation}@${operation.version}`, operation);
    return [...byName.values()];
  };
  const procedureCatalog = async (): Promise<readonly CompiledProcedure[]> => {
    const byIdentity = new Map<string, CompiledProcedure>();
    for (const procedure of (await options.procedures?.()) ?? [])
      byIdentity.set(`${procedure.procedure}@${procedure.version}`, procedure);
    const opened = documents
      .all()
      .filter((document) => !templateContexts.has(document.uri) && kindOf(document) === "procedure");
    // Resolve opened documents child-first without making opening order part of stdio behavior.
    for (let pass = 0; pass < opened.length; pass++) {
      let added = false;
      for (const document of opened) {
        const analysis = analyzeProcedure({
          source: document.getText(),
          sourceName: document.uri,
          operations: catalog(),
          procedures: [...byIdentity.values()],
        });
        if (!analysis.compiled) continue;
        const identity = `${analysis.compiled.procedure}@${analysis.compiled.version}`;
        if (byIdentity.get(identity)?.definitionDigest !== analysis.compiled.definitionDigest) added = true;
        byIdentity.set(identity, analysis.compiled);
      }
      if (!added) break;
    }
    return [...byIdentity.values()];
  };

  connection.onInitialize((): InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        hoverProvider: true,
        documentLinkProvider: { resolveProvider: false },
        completionProvider: { triggerCharacters: [" ", '"', ".", "$", "@"] },
        foldingRangeProvider: true,
        semanticTokensProvider: { legend: { tokenTypes: [...semanticTokenTypes], tokenModifiers: [] }, full: true },
      },
    };
  });

  const update = async (document: TextDocument) => {
    const kind = templateContexts.has(document.uri)
      ? kindOf(document)
      : (documentKind(document) ?? documentKinds.get(document.uri));
    if (kind) documentKinds.set(document.uri, kind);
    if (kind === "operation" && !templateContexts.has(document.uri)) {
      const analysis = analyzeOperation({ source: document.getText(), sourceName: document.uri });
      if ("compiled" in analysis) openOperations.set(document.uri, analysis.compiled);
      else openOperations.delete(document.uri);
    }
    if (templateContexts.has(document.uri)) openOperations.delete(document.uri);
    await publishDiagnostics(document);
  };

  connection.onNotification(templateDocumentContextMethod, (value: unknown) => {
    const context = templateContext(value);
    if (!context) {
      if (typeof value === "object" && value !== null && "uri" in value && typeof value.uri === "string") {
        templateContexts.set(value.uri, { uri: value.uri, parameters: [] });
        invalidTemplateContexts.add(value.uri);
        const document = documents.get(value.uri);
        if (document) void update(document);
      }
      return;
    }
    invalidTemplateContexts.delete(context.uri);
    if (context.parameters === null) templateContexts.delete(context.uri);
    else templateContexts.set(context.uri, context);
    const document = documents.get(context.uri);
    if (document) {
      documentKinds.delete(context.uri);
      void update(document);
    }
  });

  documents.onDidChangeContent(({ document }) => update(document));
  documents.onDidClose(({ document }) => {
    invalidTemplateContexts.delete(document.uri);
    templateContexts.delete(document.uri);
    documentKinds.delete(document.uri);
    openOperations.delete(document.uri);
    sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: [] });
  });

  connection.onDocumentFormatting(({ textDocument }): TextEdit[] => {
    const document = documents.get(textDocument.uri);
    if (!document) return [];
    if (templateContexts.has(document.uri) && !kindOf(document)) return [];
    const source = document.getText();
    const formatted = formatGherkinSource(source);
    return formatted === source
      ? []
      : [{ range: { start: { line: 0, character: 0 }, end: document.positionAt(source.length) }, newText: formatted }];
  });

  connection.onFoldingRanges(({ textDocument }): FoldingRange[] => {
    const document = documents.get(textDocument.uri);
    if (!document) return [];
    const view = projection(document);
    const ranges = foldingRanges(authoringDocument(document).getText());
    return view
      ? ranges
          .filter((value) =>
            view.safeRange({
              start: { line: value.startLine, character: 0 },
              end: { line: value.endLine, character: 0 },
            }),
          )
          .map((value) => ({
            ...value,
            startLine: view.range({
              start: { line: value.startLine, character: 0 },
              end: { line: value.endLine, character: 0 },
            }).start.line,
            endLine: view.range({
              start: { line: value.startLine, character: 0 },
              end: { line: value.endLine, character: 0 },
            }).end.line,
          }))
      : ranges;
  });

  connection.onCompletion(async ({ textDocument, position }): Promise<CompletionItem[]> => {
    const document = documents.get(textDocument.uri);
    if (!document) return [];
    const kind = kindOf(document);
    const view = projection(document);
    if (!kind || view?.inPlaceholder(position)) return [];
    const items = completionItems(
      authoringDocument(document),
      view?.toProjected(position) ?? position,
      kind,
      catalog(),
      await procedureCatalog(),
    );
    if (!view) return items;
    return items.flatMap((item) => {
      if (!item.textEdit) return [item];
      if (!("range" in item.textEdit) || !view.safeRange(item.textEdit.range)) return [];
      return [{ ...item, textEdit: { ...item.textEdit, range: view.range(item.textEdit.range) } }];
    });
  });

  const references = async (uri: string) => {
    const document = documents.get(uri);
    if (!document || kindOf(document) !== "procedure") return [];
    const view = projection(document);
    const found = resourceReferences(authoringDocument(document).getText(), catalog(), await procedureCatalog());
    return view
      ? found.filter((item) => view.safeRange(item.range)).map((item) => ({ ...item, range: view.range(item.range) }))
      : found;
  };
  connection.onDocumentLinks(async ({ textDocument }) =>
    (await references(textDocument.uri)).map(({ range, target }) => ({ range, target })),
  );
  connection.onHover(async ({ textDocument, position }) => {
    const reference = (await references(textDocument.uri)).find(
      ({ range }) =>
        range.start.line === position.line &&
        range.start.character <= position.character &&
        position.character < range.end.character,
    );
    return reference
      ? { contents: { kind: "markdown" as const, value: reference.markdown }, range: reference.range }
      : null;
  });

  connection.languages.semanticTokens.on(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    return document && kindOf(document) ? semanticTokens(document.getText()) : null;
  });

  connection.onDocumentSymbol(async ({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    if (!document) return [];
    const kind = kindOf(document);
    const view = projection(document);
    const effective = authoringDocument(document);
    let symbols: DocumentSymbol[] = [];
    if (kind === "operation") {
      const analysis = analyzeOperation({ source: effective.getText(), sourceName: document.uri });
      if (analysis.document) symbols = operationSymbols(analysis.document);
    } else if (kind === "procedure") symbols = procedureSymbols(effective, catalog(), await procedureCatalog());
    if (!view) return symbols;
    const mapSymbol = (symbol: DocumentSymbol): DocumentSymbol => ({
      ...symbol,
      range: view.range(symbol.range),
      selectionRange: view.range(symbol.selectionRange),
      ...(symbol.children ? { children: symbol.children.map(mapSymbol) } : {}),
    });
    return symbols.map(mapSymbol);
  });

  async function publishDiagnostics(document: TextDocument): Promise<void> {
    const version = document.version;
    const context = templateContexts.get(document.uri);
    const view = projection(document);
    const effective = authoringDocument(document);
    const source = effective.getText();
    const kind = kindOf(document);
    let diagnostics: Diagnostic[] = [];
    if (kind === "operation") {
      diagnostics = analyzeOperation({ source, sourceName: document.uri }).diagnostics.map((diagnostic) => ({
        severity: DiagnosticSeverity.Error,
        range: lspRange(diagnostic.range),
        message: diagnostic.message,
        code: diagnostic.code,
        source: "trust-operation",
      }));
    } else if (kind === "procedure") {
      try {
        diagnostics = analyzeProcedure({
          source,
          sourceName: document.uri,
          operations: catalog(),
          procedures: await procedureCatalog(),
        }).diagnostics.map((diagnostic) => ({
          severity: DiagnosticSeverity.Error,
          range: diagnosticRange(effective, diagnostic.location),
          message: diagnostic.message,
          code: diagnostic.code,
          source: "trust-procedure",
        }));
      } catch {
        diagnostics = [
          {
            severity: DiagnosticSeverity.Error,
            range: lineTextRange(0, source.split("\n")[0] ?? ""),
            message: "The Procedure catalog is unavailable. Retry when the connection is restored.",
            code: "catalog-unavailable",
            source: "trust-procedure",
          },
        ];
      }
    }
    if (view) {
      // Scope fragments use their compiler-owned analyzer without inventing a resource identity.
      if (view.fragment) {
        diagnostics = [];
        try {
          diagnostics = analyzeProcedureScopeFragment(source, document.uri).map((item) => ({
            severity: DiagnosticSeverity.Error,
            range: view.range(diagnosticRange(effective, item.location)),
            message: item.message,
            code: item.code,
            source: "trust-procedure",
          }));
        } catch (error) {
          if (error instanceof GherkinSyntaxError)
            diagnostics = [
              {
                range: { start: { line: 0, character: 0 }, end: document.positionAt(document.getText().length) },
                severity: DiagnosticSeverity.Error,
                source: "trust-template",
                code: "template-fragment-syntax",
                message: error.message,
              },
            ];
        }
      } else diagnostics = diagnostics.map((item) => ({ ...item, range: view.range(item.range) }));
      if (view.unresolved) diagnostics = diagnostics.filter((item) => !view.dependsOnUnresolved(item.range));
      diagnostics.push(...view.diagnostics);
      if (invalidTemplateContexts.has(document.uri))
        diagnostics = [
          {
            range: lineTextRange(0, document.getText().split("\n")[0] ?? ""),
            severity: DiagnosticSeverity.Error,
            source: "trust-template",
            code: "template-context-invalid",
            message:
              "Template parameters are invalid; complete unique parameter names and valid defaults before validation.",
          },
        ];
    }
    if (
      documents.get(document.uri) !== document ||
      document.version !== version ||
      templateContexts.get(document.uri) !== context
    )
      return;
    sendDiagnostics({ uri: document.uri, version, diagnostics });
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
  return (
    sourceKind(document.getText()) ??
    (document.languageId === "trust-operation"
      ? "operation"
      : document.languageId === "trust-procedure"
        ? "procedure"
        : undefined)
  );
}

function semanticTokens(source: string) {
  const vocabulary = sourceKind(source) === "operation" ? operationHighlightVocabulary : procedureHighlightVocabulary;
  const builder = new SemanticTokensBuilder();
  highlightGherkinSource(source, vocabulary).forEach((tokens, line) => {
    let character = 0;
    for (const token of tokens) {
      const type = token.cls ? semanticTokenIndexes.get(token.cls) : undefined;
      if (type !== undefined && token.text.length > 0) builder.push(line, character, token.text.length, type, 0);
      character += token.text.length;
    }
  });
  return builder.build();
}

function completionItems(
  document: TextDocument,
  position: Position,
  kind: LanguageKind,
  operations: readonly CompiledOperation[],
  procedures: readonly CompiledProcedure[],
): CompletionItem[] {
  const parsed = parseSource(document.getText());
  const embedded = embeddedLanguageAt(parsed, position.line + 1);
  if (embedded === "js") return jsCompletions(document, position, operations, procedures);
  if (embedded === "jsonata") return jsonataCompletions(document, position);
  return sentenceCompletions(document, parsed, position, kind, operations, procedures);
}

/* Sentence completion is slot-based: the Gherkin AST locates the step under the cursor
   (continuation lines included), the sentence tokenizer yields the tokens before the cursor,
   and the token ending the prefix names the grammar slot being filled. Facts that feed the
   slots (roles, scenario slugs, interface fields) come from the AST, not the compiled model,
   so they stay available while the sentence being typed is still incomplete. */

type Container = "background" | "scenario";

interface Suggestion {
  readonly label: string;
  readonly kind: CompletionItemKind;
  readonly detail: string;
  readonly quoted?: boolean;
  readonly insertText?: string;
}

const keyword = (label: string, detail: string): Suggestion => ({ label, kind: CompletionItemKind.Keyword, detail });
const quotedValue = (label: string, kind: CompletionItemKind, detail: string): Suggestion => ({
  label,
  kind,
  detail,
  quoted: true,
});

function sentenceCompletions(
  document: TextDocument,
  parsed: GherkinDocument | undefined,
  position: Position,
  kind: LanguageKind,
  operations: readonly CompiledOperation[],
  procedures: readonly CompiledProcedure[],
): CompletionItem[] {
  const source = document.getText();
  const line = position.line + 1;
  if (!parsed?.feature) {
    const language = kind === "operation" ? operationLanguage : procedureLanguage;
    return source.trim() === ""
      ? [snippet(kind === "operation" ? "Operation feature" : "Procedure feature", language.template)]
      : [];
  }
  const cell = tableRowAt(parsed, line);
  if (cell) return kind === "operation" ? operationTableCompletions(document, position, cell) : [];
  const lines = splitLines(source);
  const site = stepSiteAt(parsed, lines, line);
  if (!site) return blockCompletions(parsed, line, kind, operations);
  const prefix = sentencePrefixAt(lines, site.step, line, position.character);
  if (prefix === undefined) return blockCompletions(parsed, line, kind, operations);
  const tokens = prefixTokens(prefix);
  if (!tokens) return [];
  const lineSuffix = (lines[position.line] ?? "").slice(position.character);
  const suggestions =
    kind === "procedure"
      ? procedureSuggestions(site, tokens.tokens, parsed, operations, lineSuffix, procedures)
      : operationSuggestions(site, tokens.tokens, source);
  return suggestions.map(suggestionRenderer(document, position, tokens.inQuote));
}

interface StepSite {
  readonly step: Step;
  readonly container: Container;
}

function stepSiteAt(parsed: GherkinDocument, lines: readonly string[], line: number): StepSite | undefined {
  for (const child of parsed.feature?.children ?? []) {
    const scopes = [
      [child.background?.steps ?? [], "background"],
      [child.scenario?.steps ?? [], "scenario"],
    ] as const;
    for (const [steps, container] of scopes)
      for (const step of steps) {
        if (step.location.line > line) break;
        if (step.location.line === line) return { step, container };
        if (continuationLineIndexes(lines, step.location.line - 1).includes(line - 1)) return { step, container };
      }
  }
  return undefined;
}

/** The sentence text from the step keyword to the cursor: the source truncated at the cursor,
    folded by the parser's own continuation rule so slot detection sees what the parser sees. */
function sentencePrefixAt(lines: readonly string[], step: Step, line: number, character: number): string | undefined {
  const textStart = (step.location.column ?? 1) - 1 + step.keyword.length;
  if (line === step.location.line && character < textStart) return undefined;
  const truncated = lines.slice(0, line);
  truncated[line - 1] = (truncated[line - 1] ?? "").slice(0, character);
  const folded = splitLines(joinContinuations(truncated.join("\n")))[step.location.line - 1] ?? "";
  return folded.slice(textStart);
}

interface PrefixTokens {
  readonly tokens: readonly SentenceToken[];
  readonly inQuote: boolean;
}

/** Tokenize the sentence prefix; an unclosed quote marks the cursor inside a quoted slot. */
function prefixTokens(prefix: string): PrefixTokens | undefined {
  try {
    return { tokens: tokenizeSentence(prefix), inQuote: false };
  } catch (error) {
    if (!(error instanceof SentenceSyntaxError) || prefix[error.offset] !== '"') return undefined;
    try {
      return { tokens: tokenizeSentence(prefix.slice(0, error.offset)), inQuote: true };
    } catch {
      return undefined;
    }
  }
}

function procedureSuggestions(
  site: StepSite,
  tokens: readonly SentenceToken[],
  parsed: GherkinDocument,
  operations: readonly CompiledOperation[],
  lineSuffix: string,
  procedures: readonly CompiledProcedure[],
): Suggestion[] {
  const facts = procedureFacts(parsed);
  const roles = facts.roles.map((role) => quotedValue(role, CompletionItemKind.Variable, "Plan context role"));
  if (site.container === "scenario" && tokens.length === 0)
    return [checkSnippetSuggestion(operations), dependencySnippetSuggestion(facts.scenarios)];
  const operation = operationForCheck(tokens, operations);
  return stepGrammarExpectations(procedureStepGrammar, tokens, site.container).flatMap((expectation) => {
    if (expectation.kind === "literal") {
      if (expectation.value === procedureLanguage.phrases.scope) {
        return [procedureScopeSnippetSuggestion()];
      }
      if (expectation.value === "optionally") {
        return [
          {
            ...keyword(expectation.value, expectation.detail),
            insertText: /^\s*by\s+agent\b/.test(lineSuffix) ? "optionally " : "optionally by agent",
          },
        ];
      }
      if (expectation.value === "within") {
        return [
          {
            label: expectation.value,
            kind: CompletionItemKind.Snippet,
            detail: expectation.detail,
            insertText: `within "\${1:10m}"`,
          },
        ];
      }
      if (expectation.value === "until") {
        return [
          {
            label: expectation.value,
            kind: CompletionItemKind.Snippet,
            detail: expectation.detail,
            insertText: `until "\${1:2099-12-31T23:59:59Z}"`,
          },
        ];
      }
      return [keyword(expectation.value, expectation.detail)];
    }
    if (expectation.kind === "one-of") {
      const kind = expectation.slot === "value-type" ? CompletionItemKind.TypeParameter : CompletionItemKind.Keyword;
      return expectation.values.map((value) => ({
        label: value,
        kind,
        detail: expectation.detail,
        quoted: expectation.quoted,
      }));
    }
    switch (expectation.slot) {
      case "scenario":
        return facts.scenarios.map((slug) => quotedValue(slug, CompletionItemKind.Event, expectation.detail));
      case "operation":
        return tokens[0]?.value === "Invocation"
          ? procedures.map((candidate) =>
              quotedValue(`${candidate.procedure}@${candidate.version}`, CompletionItemKind.Module, candidate.title),
            )
          : operations.map((candidate) =>
              quotedValue(`${candidate.operation}@${candidate.version}`, CompletionItemKind.Module, candidate.title),
            );
      case "parent-role":
      case "each-parent-role":
      case "target-role":
      case "using-role":
      case "using-all-role":
      case "materialized-role":
        return roles;
      case "input":
      case "plan-input":
      case "using-input":
      case "using-all-input":
        return operation
          ? Object.keys(operation.input.properties).map((name) =>
              quotedValue(name, CompletionItemKind.Property, expectation.detail),
            )
          : [];
      case "execution-duration":
        return ["500ms", "30s", "10m", "1h"].map((value) =>
          quotedValue(value, CompletionItemKind.Value, "Compact Check execution duration"),
        );
      case "field":
        return operation
          ? Object.keys(operation.produced.properties).map((name) =>
              quotedValue(name, CompletionItemKind.Field, expectation.detail),
            )
          : [];
      default:
        return [];
    }
  });
}

function procedureScopeSnippetSuggestion(): Suggestion {
  return {
    label: procedureLanguage.phrases.scope,
    kind: CompletionItemKind.Snippet,
    detail: "Mandatory Procedure action scope",
    insertText: `${procedureLanguage.phrases.scope}\n      | check | authorized | forbidden |\n      | all   | \${1:Authorized actions.} | \${2:Forbidden actions.} |`,
  };
}

function operationSuggestions(site: StepSite, tokens: readonly SentenceToken[], source: string): Suggestion[] {
  const model = analyzeOperation({ source }).document;
  const environment = (model?.environment ?? []).map((field) =>
    quotedValue(field.name, CompletionItemKind.Variable, `Environment: ${field.type}`),
  );
  const inputs = (model?.input ?? []).map((field) =>
    quotedValue(field.name, CompletionItemKind.Property, `Input: ${field.type}`),
  );
  const credentials = (model?.credentials ?? []).map((credential) =>
    quotedValue(credential.name, CompletionItemKind.Constant, "Declared Credential"),
  );
  if (site.container === "scenario" && tokens.length === 0) return scenarioStepSuggestions();
  return stepGrammarExpectations(operationStepGrammar, tokens, site.container).flatMap((expectation) =>
    operationGrammarSuggestions(expectation, environment, inputs, credentials),
  );
}

function operationGrammarSuggestions(
  expectation: StepGrammarExpectation,
  environment: readonly Suggestion[],
  inputs: readonly Suggestion[],
  credentials: readonly Suggestion[],
): Suggestion[] {
  if (expectation.kind === "literal") return [keyword(expectation.value, expectation.detail)];
  if (expectation.kind === "one-of") {
    return expectation.values.map((value) => ({
      label: value,
      kind: CompletionItemKind.EnumMember,
      detail: expectation.detail,
      quoted: expectation.quoted,
    }));
  }
  if (expectation.slot === "environment" || expectation.slot.endsWith("-environment")) return [...environment];
  if (expectation.slot === "input" || expectation.slot.endsWith("-input")) return [...inputs];
  if (expectation.slot.endsWith("-credential")) return [...credentials];
  return [];
}

/** AST-level facts for slots: available even while the sentence being typed does not compile yet. */
function procedureFacts(parsed: GherkinDocument): { roles: string[]; scenarios: string[] } {
  const roles: string[] = [];
  const scenarios: string[] = [];
  for (const child of parsed.feature?.children ?? []) {
    if (child.background)
      for (const step of child.background.steps) {
        const name = stepTokens(step).find((token) => token.kind === "quoted")?.value;
        if (name) roles.push(name);
      }
    if (child.scenario)
      for (const tag of child.scenario.tags) {
        if (tag.name.startsWith(procedureLanguage.tags.scenario))
          scenarios.push(tag.name.slice(procedureLanguage.tags.scenario.length));
      }
  }
  return { roles, scenarios };
}

function blockCompletions(
  parsed: GherkinDocument,
  line: number,
  kind: LanguageKind,
  operations: readonly CompiledOperation[],
): CompletionItem[] {
  let container: Container | undefined;
  for (const child of parsed.feature?.children ?? []) {
    const node = child.background ?? child.scenario ?? child.rule;
    if (!node || node.location.line >= line) break;
    container = child.background ? "background" : "scenario";
  }
  if (!container) return [];
  if (kind === "operation") {
    return operationAuthoringSnippets
      .filter(({ insertText }) => (container === "background") === /^(Given|And)\s/.test(insertText))
      .map(({ label, insertText }) => snippet(label, insertText));
  }
  if (container === "background") {
    return [
      snippet(
        "Context role",
        `Given \${1|${procedureLanguage.cardinalities.join(",")}|} \${2|${procedureLanguage.valueTypes.join(",")}|} "\${3:name}"`,
      ),
    ];
  }
  const facts = procedureFacts(parsed);
  return [checkSnippetSuggestion(operations, "Then "), dependencySnippetSuggestion(facts.scenarios, "Given ")].map(
    (entry) => snippet(entry.label, entry.insertText ?? entry.label),
  );
}

function checkSnippetSuggestion(operations: readonly CompiledOperation[], keywordPrefix = ""): Suggestion {
  const names = operations.map((operation) => `${operation.operation}@${operation.version}`);
  const slot = names.length > 0 ? `\${2|${names.join(",")}|}` : "${2:operation}";
  return {
    label: procedureLanguage.phrases.check,
    kind: CompletionItemKind.Snippet,
    detail: "Check sentence with its js qualification",
    insertText: `${keywordPrefix}Check "\${1:name}" runs Operation "${slot}"\n    on "\${3:role}" as Input "\${4:input}"\n    and must establish "\${5:reason}"\n  """js\n  \${6:fact.field} || fail("\${7:reason}")\n  """`,
  };
}

function dependencySnippetSuggestion(scenarios: readonly string[], keywordPrefix = ""): Suggestion {
  const slot = scenarios.length > 0 ? `\${1|${scenarios.join(",")}|}` : "${1:slug}";
  return {
    label: procedureLanguage.phrases.dependency,
    kind: CompletionItemKind.Snippet,
    detail: "Prerequisite Scenario dependency",
    insertText: `${keywordPrefix}${procedureLanguage.phrases.dependency} "${slot}" is validated`,
  };
}

function scenarioStepSuggestions(): Suggestion[] {
  return operationAuthoringSnippets
    .filter(({ insertText }) => /^(When|Then)\s/.test(insertText))
    .map(({ label, insertText }) => ({
      label,
      kind: CompletionItemKind.Snippet,
      detail: "Operation step",
      insertText: insertText.replace(/^(When|Then)\s/, ""),
    }));
}

interface TableSite {
  readonly step: Step;
  readonly row: TableRow;
  readonly header: TableRow;
}

function tableRowAt(parsed: GherkinDocument, line: number): TableSite | undefined {
  for (const step of allSteps(parsed)) {
    const rows = step.dataTable?.rows ?? [];
    const header = rows[0];
    if (!header) continue;
    const row = rows.find((candidate) => candidate.location.line === line);
    if (row && row !== header) return { step, row, header };
  }
  return undefined;
}

function operationTableCompletions(document: TextDocument, position: Position, site: TableSite): CompletionItem[] {
  let index = 0;
  for (const [at, cell] of site.row.cells.entries())
    if ((cell.location.column ?? 1) <= position.character + 1) index = at;
  const column = site.header.cells[index]?.value;
  const cell = site.row.cells[index];
  if (!column || !cell) return [];
  const values: Suggestion[] = [];
  if (column === "type") {
    const isEnvironment = site.step.text.split(/\s+/)[0] === operationLanguage.phrases.environment;
    const types = isEnvironment ? operationLanguage.environmentTypes : operationLanguage.valueTypes;
    values.push(
      ...types.map((type) => ({
        label: type,
        detail: isEnvironment ? "Environment type" : "Operation value type",
        kind: CompletionItemKind.TypeParameter,
      })),
    );
  } else if (column === "cardinality") {
    values.push(
      ...operationLanguage.cardinalities.map((cardinality) => ({
        label: cardinality,
        detail: "Cardinality",
        kind: CompletionItemKind.EnumMember,
      })),
    );
  } else if (column === "source") {
    values.push(
      { label: "literal", detail: "Literal argument", kind: CompletionItemKind.EnumMember },
      { label: 'Input "name"', detail: "Argument from an Input", kind: CompletionItemKind.EnumMember },
      { label: 'Execution "id"', detail: "Argument from the execution", kind: CompletionItemKind.EnumMember },
    );
  }
  const start = { line: position.line, character: Math.min((cell.location.column ?? 1) - 1, position.character) };
  return values.map(({ label, detail, kind }) => ({
    label,
    kind,
    detail,
    textEdit: { range: { start, end: position }, newText: label },
  }));
}

/** Sentence words extend expression identifiers with `-` (multi-word verbs) and `.` (operation names). */
const sentenceWordCharacter = (character: string): boolean =>
  isExpressionIdentifierPart(character) || character === "-" || character === ".";

/** One renderer per request: the prefix scans run once, not once per suggestion. */
function suggestionRenderer(
  document: TextDocument,
  position: Position,
  inQuote: boolean,
): (suggestion: Suggestion) => CompletionItem {
  const linePrefix = document.getText({ start: { line: position.line, character: 0 }, end: position });
  const quote = inQuote ? linePrefix.lastIndexOf('"') : -1;
  const closing =
    document.getText({ start: position, end: { line: position.line, character: position.character + 1 } }) === '"';
  let wordStart = linePrefix.length;
  while (wordStart > 0 && sentenceWordCharacter(linePrefix[wordStart - 1]!)) wordStart -= 1;
  const quotedRange = { start: { line: position.line, character: quote + 1 }, end: position };
  const wordRange = { start: { line: position.line, character: wordStart }, end: position };
  return (suggestion) => {
    if (suggestion.insertText !== undefined) {
      return suggestion.kind === CompletionItemKind.Snippet
        ? snippet(suggestion.label, suggestion.insertText)
        : {
            label: suggestion.label,
            kind: suggestion.kind,
            detail: suggestion.detail,
            insertText: suggestion.insertText,
          };
    }
    const base = { label: suggestion.label, kind: suggestion.kind, detail: suggestion.detail };
    if (suggestion.quoted && quote >= 0) {
      return {
        ...base,
        textEdit: { range: quotedRange, newText: closing ? suggestion.label : `${suggestion.label}"` },
      };
    }
    return {
      ...base,
      textEdit: { range: wordRange, newText: suggestion.quoted ? `"${suggestion.label}"` : suggestion.label },
    };
  };
}

function jsCompletions(
  document: TextDocument,
  position: Position,
  operations: readonly CompiledOperation[],
  procedures: readonly CompiledProcedure[],
): CompletionItem[] {
  const source = document.getText();
  const path = qualificationCompletionPath(source, document.offsetAt(position));
  const model = compileProcedureModel(source, operations, procedures);
  const currentCheck = checkAt(source, position.line + 1, model);
  const operation = operations.find((candidate) => candidate.operation === currentCheck?.operation);
  const roots = procedureLanguage.qualification.roots;
  if (path?.root === roots.fact) {
    return operation
      ? Object.entries(operation.produced.properties).map(([name, schema]) =>
          memberItem(document, name, CompletionItemKind.Field, schemaDescription(schema), path, position),
        )
      : [];
  }
  if (path?.root === roots.context)
    return (model?.roles ?? []).map((role) =>
      memberItem(document, role.name, CompletionItemKind.Variable, "Typed Plan context role", path, position),
    );
  if (path?.root === roots.checks) {
    const checkName = path.members[0];
    if (checkName) {
      const referenced = model?.checks.find((entry) => entry.name === checkName);
      const provider = operations.find((candidate) => candidate.operation === referenced?.operation);
      return provider
        ? Object.entries(provider.produced.properties).map(([name, schema]) =>
            memberItem(document, name, CompletionItemKind.Field, schemaDescription(schema), path, position),
          )
        : [];
    }
    return prerequisiteChecks(model, currentCheck?.scenario).map((entry) =>
      memberItem(document, entry.name, CompletionItemKind.Variable, `Check using ${entry.operation}`, path, position),
    );
  }
  const mathRoot = procedureLanguage.qualification.roots.math;
  if (path?.root === mathRoot)
    return Object.keys(procedureLanguage.qualification.mathFunctions).map((name) =>
      memberItem(document, name, CompletionItemKind.Function, "Supported numeric function", path, position),
    );
  const root = identifierRenderer(document, position, identifierPathBefore(source, document.offsetAt(position)));
  return [
    root(
      procedureLanguage.qualification.roots.fact,
      CompletionItemKind.Variable,
      "Fields produced by this Check's Operation",
    ),
    root(procedureLanguage.qualification.roots.context, CompletionItemKind.Variable, "Typed Plan context"),
    root(procedureLanguage.qualification.roots.checks, CompletionItemKind.Variable, "Facts from prerequisite Checks"),
    root(mathRoot, CompletionItemKind.Class, "Supported numeric functions"),
    snippet(procedureLanguage.qualification.fail, procedureLanguage.qualification.fail + '("${1:reason}")'),
  ];
}

function jsonataCompletions(document: TextDocument, position: Position): CompletionItem[] {
  const source = document.getText();
  const path = identifierPathBefore(source, document.offsetAt(position));
  const model = analyzeOperation({ source }).document;
  const [stepsRoot, inputRoot, environmentRoot] = operationLanguage.jsonata.roots;
  const member = identifierRenderer(document, position, path);
  if (path === stepsRoot || path === `${stepsRoot}.`)
    return (model?.steps ?? []).map(({ name }) => member(name, CompletionItemKind.Variable, "Operation step result"));
  const stepPath = path.split(".");
  if (stepPath[0] === stepsRoot && stepPath.length >= 3) {
    const step = model?.steps.find(({ name }) => name === stepPath[1]);
    const fields = step ? operationLanguage.stepResults[step.type] : [];
    return fields.map((name) => member(name, CompletionItemKind.Property, `${step?.type ?? "Operation"} step result`));
  }
  if (path === inputRoot || path.startsWith(`${inputRoot}.`))
    return (model?.input ?? []).map(({ name }) => member(name, CompletionItemKind.Property, "Operation input"));
  if (path === environmentRoot || path.startsWith(`${environmentRoot}.`))
    return (model?.environment ?? []).map(({ name }) =>
      member(name, CompletionItemKind.Property, "Operation environment"),
    );
  return [
    member(stepsRoot, CompletionItemKind.Variable, "Results of named Operation steps"),
    member(inputRoot, CompletionItemKind.Variable, "Typed Operation input"),
    member(environmentRoot, CompletionItemKind.Variable, "Operation environment"),
    ...operationLanguage.jsonata.functions.map((name) =>
      member(`$${name}`, CompletionItemKind.Function, "JSONata built-in function"),
    ),
  ];
}

/** One replace range per request: the partial identifier before the cursor (`$` included), so the client needs no word logic. */
function identifierRenderer(
  document: TextDocument,
  position: Position,
  path: string,
): (label: string, kind: CompletionItemKind, detail: string) => CompletionItem {
  const partial = path.slice(path.lastIndexOf(".") + 1);
  const start = document.positionAt(document.offsetAt(position) - partial.length);
  const range = { start, end: position };
  return (label, kind, detail) => ({ label, kind, detail, textEdit: { range, newText: label } });
}

function embeddedLanguageAt(parsed: GherkinDocument | undefined, line: number): "js" | "jsonata" | undefined {
  const step = allSteps(parsed).find((candidate) => {
    const start = candidate.docString?.location?.line;
    const length = candidate.docString?.content.split("\n").length ?? 0;
    return start !== undefined && line > start && line <= start + length;
  });
  if (!step?.docString) return undefined;
  return step.docString.mediaType === procedureLanguage.qualification.mediaType
    ? "js"
    : step.text === operationLanguage.phrases.produce
      ? "jsonata"
      : undefined;
}

function compileProcedureModel(
  source: string,
  operations: readonly CompiledOperation[],
  procedures: readonly CompiledProcedure[],
): CompiledProcedure | undefined {
  return analyzeProcedure({ source, operations, procedures }).compiled;
}

function operationForCheck(
  tokens: readonly SentenceToken[],
  operations: readonly CompiledOperation[],
): CompiledOperation | undefined {
  const quoted = tokens.filter((token) => token.kind === "quoted");
  const reference = parseResourceReference(quoted[1]?.value ?? "");
  if (!reference) return undefined;
  const candidates = operations.filter((operation) => operation.operation === reference.name);
  const version = selectVersion(
    candidates.map((operation) => operation.version),
    reference.selector,
  );
  return candidates.find((operation) => operation.version === version);
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

function snippet(label: string, insertText: string): CompletionItem {
  return { label, kind: CompletionItemKind.Snippet, insertText, insertTextFormat: 2 };
}
function memberItem(
  document: TextDocument,
  label: string,
  kind: CompletionItemKind,
  detail: string,
  path: QualificationCompletionPath,
  position: Position,
): CompletionItem {
  const member = expressionMember(label);
  const source = document.getText();
  const hasDot = source[path.replaceOffset - 1] === ".";
  const startOffset = hasDot && member.startsWith("[") ? path.replaceOffset - 1 : path.replaceOffset;
  const start = document.positionAt(startOffset);
  return {
    label,
    kind,
    detail,
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
    const end = (children[index + 1]?.background ?? children[index + 1]?.scenario ?? children[index + 1]?.rule)
      ?.location.line;
    if ((end ?? lastLine + 1) > start + 1)
      ranges.push({ startLine: start, endLine: (end ?? lastLine + 1) - 2, kind: FoldingRangeKind.Region });
  }
  for (const step of allSteps(parsed)) {
    const start = step.docString?.location?.line;
    const length = step.docString?.content.split("\n").length ?? 0;
    if (start !== undefined && length > 1)
      ranges.push({ startLine: start - 1, endLine: start + length, kind: FoldingRangeKind.Region });
  }
  return ranges;
}

function procedureSymbols(
  document: TextDocument,
  operations: readonly CompiledOperation[],
  procedures: readonly CompiledProcedure[],
): DocumentSymbol[] {
  const source = document.getText();
  const model = compileProcedureModel(source, operations, procedures);
  const parsed = parseSource(source);
  if (!model || !parsed?.feature) return [];
  const rootRange = { start: { line: 0, character: 0 }, end: document.positionAt(source.length) };
  const children: DocumentSymbol[] = [];
  const lines = source.split("\n");
  for (const child of parsed.feature.children) {
    if (child.background)
      for (const step of child.background.steps) {
        const role = stepTokens(step).find((token) => token.kind === "quoted")?.value;
        if (!role || !model.roles.some((candidate) => candidate.name === role)) continue;
        const range = lineTextRange(step.location.line - 1, lines[step.location.line - 1] ?? "");
        children.push(DocumentSymbol.create(role, "Context role", SymbolKind.Variable, range, range));
      }
    if (!child.scenario) continue;
    const scenarioRange = lineTextRange(
      child.scenario.location.line - 1,
      lines[child.scenario.location.line - 1] ?? "",
    );
    children.push(
      DocumentSymbol.create(child.scenario.name, "Scenario", SymbolKind.Event, scenarioRange, scenarioRange),
    );
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
  try {
    return parseGherkin(source);
  } catch (error) {
    if (error instanceof GherkinSyntaxError) return undefined;
    throw error;
  }
}

function allSteps(document: GherkinDocument | undefined): readonly Step[] {
  return (
    document?.feature?.children.flatMap(
      (child) =>
        child.background?.steps ??
        child.scenario?.steps ??
        child.rule?.children.flatMap((nested) => nested.background?.steps ?? nested.scenario?.steps ?? []) ??
        [],
    ) ?? []
  );
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
  try {
    return tokenizeSentence(step.text);
  } catch {
    return [];
  }
}

function operationSymbols(document: OperationDocument): DocumentSymbol[] {
  const children: DocumentSymbol[] = [
    ...document.environment.map((field) =>
      DocumentSymbol.create(
        field.name,
        `Environment: ${field.type}`,
        SymbolKind.Variable,
        lspRange(field.range),
        lspRange(field.selectionRange),
      ),
    ),
    ...document.credentials.map((credential) =>
      DocumentSymbol.create(
        credential.name,
        "Credential",
        SymbolKind.Constant,
        lspRange(credential.range),
        lspRange(credential.selectionRange),
      ),
    ),
    ...document.input.map((field) =>
      DocumentSymbol.create(
        field.name,
        `Input: ${field.type} ${field.cardinality}`,
        SymbolKind.Property,
        lspRange(field.range),
        lspRange(field.selectionRange),
      ),
    ),
    ...document.steps.map((step) =>
      DocumentSymbol.create(
        step.name,
        `Step: ${step.type}`,
        SymbolKind.Function,
        lspRange(step.range),
        lspRange(step.selectionRange),
      ),
    ),
    ...document.produced.map((field) =>
      DocumentSymbol.create(
        field.name,
        `Produced: ${field.type} ${field.cardinality}`,
        SymbolKind.Field,
        lspRange(field.range),
        lspRange(field.selectionRange),
      ),
    ),
  ];
  const firstLine = document.description
    ?.split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
  return [
    DocumentSymbol.create(
      document.operation ?? document.title,
      `${document.version ? `Operation ${document.version}` : "Operation"}${firstLine ? ` — ${firstLine}` : ""}`,
      SymbolKind.Module,
      lspRange(document.range),
      lspRange(document.selectionRange),
      children,
    ),
  ];
}

function diagnosticRange(document: TextDocument, location?: { readonly line: number; readonly column: number }): Range {
  if (!location) return lineTextRange(0, document.getText().split("\n")[0] ?? "");
  const line = Math.max(0, Math.min(document.lineCount - 1, location.line - 1));
  const text =
    document
      .getText({
        start: { line, character: 0 },
        end:
          line + 1 < document.lineCount
            ? { line: line + 1, character: 0 }
            : document.positionAt(document.getText().length),
      })
      .split("\n")[0] ?? "";
  const start = Math.max(0, Math.min(text.length, location.column - 1));
  return { start: { line, character: start }, end: { line, character: Math.max(start + 1, text.length) } };
}

function lineTextRange(line: number, text: string): Range {
  return { start: { line, character: 0 }, end: { line, character: Math.max(1, text.length) } };
}
function lspRange(range: SourceRange): Range {
  return {
    start: { line: range.start.line - 1, character: range.start.column - 1 },
    end: { line: range.end.line - 1, character: range.end.column - 1 },
  };
}

import { parseResourceReference, selectVersion } from "@trust/operation/version";
