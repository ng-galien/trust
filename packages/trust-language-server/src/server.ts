import {
  createConnection,
  DiagnosticSeverity,
  DocumentSymbol,
  ProposedFeatures,
  SymbolInformation,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  type Diagnostic,
  type InitializeParams,
  type InitializeResult,
  type Range,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

import {
  analyzeOperation,
  isOperationSource,
  type OperationDocument,
  type SourceRange,
} from "@trust/operation";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const operationDocuments = new Set<string>();
let hierarchicalDocumentSymbols = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hierarchicalDocumentSymbols = params.capabilities.textDocument?.documentSymbol
    ?.hierarchicalDocumentSymbolSupport === true;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
    },
  };
});

documents.onDidOpen(({ document }) => {
  if (isOperationSource(document.getText())) operationDocuments.add(document.uri);
  publishDiagnostics(document);
});

documents.onDidChangeContent(({ document }) => {
  if (isOperationSource(document.getText())) operationDocuments.add(document.uri);
  publishDiagnostics(document);
});

documents.onDidClose(({ document }) => {
  operationDocuments.delete(document.uri);
  connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: [] });
});

connection.onDocumentSymbol(({ textDocument }) => {
  const document = documents.get(textDocument.uri);
  if (!document || !operationDocuments.has(document.uri)) return [];
  const analysis = analyzeOperation({ source: document.getText(), sourceName: document.uri });
  if (!analysis.document) return [];
  return hierarchicalDocumentSymbols
    ? operationSymbols(analysis.document)
    : operationSymbolInformation(analysis.document, document.uri);
});

function publishDiagnostics(document: TextDocument): void {
  if (!operationDocuments.has(document.uri)) {
    connection.sendDiagnostics({
      uri: document.uri,
      version: document.version,
      diagnostics: [],
    });
    return;
  }
  const analysis = analyzeOperation({ source: document.getText(), sourceName: document.uri });
  const diagnostics: Diagnostic[] = analysis.diagnostics.map((diagnostic) => ({
    severity: DiagnosticSeverity.Error,
    range: lspRange(diagnostic.range),
    message: diagnostic.message,
    code: diagnostic.code,
    source: "trust-operation",
  }));
  connection.sendDiagnostics({
    uri: document.uri,
    version: document.version,
    diagnostics,
  });
}

function operationSymbols(document: OperationDocument): DocumentSymbol[] {
  const children: DocumentSymbol[] = [
    ...document.environment.map((field) => DocumentSymbol.create(
      field.name,
      `Environment: ${field.type}`,
      SymbolKind.Variable,
      lspRange(field.range),
      lspRange(field.selectionRange),
    )),
    ...document.input.map((field) => DocumentSymbol.create(
      field.name,
      `Input: ${field.type} ${field.cardinality}`,
      SymbolKind.Property,
      lspRange(field.range),
      lspRange(field.selectionRange),
    )),
    ...document.steps.map((step) => DocumentSymbol.create(
      step.name,
      `Step: ${step.type}`,
      SymbolKind.Function,
      lspRange(step.range),
      lspRange(step.selectionRange),
    )),
    ...document.produced.map((field) => DocumentSymbol.create(
      field.name,
      `Produced: ${field.type} ${field.cardinality}`,
      SymbolKind.Field,
      lspRange(field.range),
      lspRange(field.selectionRange),
    )),
  ];
  return [DocumentSymbol.create(
    document.operation ?? document.title,
    document.version ? `Operation ${document.version}` : "Operation",
    SymbolKind.Module,
    lspRange(document.range),
    lspRange(document.selectionRange),
    children,
  )];
}

function operationSymbolInformation(
  document: OperationDocument,
  uri: string,
): SymbolInformation[] {
  const root = operationSymbols(document)[0];
  if (!root) return [];
  return [
    SymbolInformation.create(root.name, root.kind, root.selectionRange, uri),
    ...(root.children ?? []).map((child) => SymbolInformation.create(
      child.name,
      child.kind,
      child.selectionRange,
      uri,
      root.name,
    )),
  ];
}

function lspRange(range: SourceRange): Range {
  return {
    start: { line: range.start.line - 1, character: range.start.column - 1 },
    end: { line: range.end.line - 1, character: range.end.column - 1 },
  };
}

documents.listen(connection);
connection.listen();
