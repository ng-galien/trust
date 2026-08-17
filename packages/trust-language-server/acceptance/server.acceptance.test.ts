import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";

test("the Microsoft LSP server exposes the Operation language through standard JSON-RPC", async (context) => {
  const session = await startLanguageServer(context, true);
  const { connection } = session;

  await assertIgnoredDocument(connection);
  await assertInvalidOperationOpenedDirectly(connection);
  await assertValidCatalog(connection);
  await assertInvalidFixtures(connection);
  await assertIncrementalDiagnostics(connection);

  await session.shutdown();
});

test("the server accepts step continuation lines and formats long steps onto them", async (context) => {
  const session = await startLanguageServer(context, true);
  const uri = "file:///workspace/format/git.head-read.feature";
  const original = operationFixture("valid/git.head-read.feature");
  const longStep = 'When Shell "head" runs "git" with cwd from Environment "workspaceRoot" and Input "project"';
  assert.ok(original.includes(longStep), "fixture carries the long step");
  const diagnostics = waitForDiagnostics(session.connection, uri, 1);
  session.connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "gherkin", version: 1, text: original },
  });
  assert.deepEqual(await diagnostics, { uri, version: 1, diagnostics: [] });

  const edits = await session.connection.sendRequest<Array<{ newText: string }>>(
    "textDocument/formatting",
    { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } },
  );
  assert.equal(edits.length, 1);
  const formatted = edits[0]!.newText;
  assert.ok(formatted.includes('When Shell "head" runs "git" with cwd from Environment "workspaceRoot"\n        and Input "project"'), formatted);

  const reopened = "file:///workspace/format/continued.feature";
  const reopenedDiagnostics = waitForDiagnostics(session.connection, reopened, 1);
  session.connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: reopened, languageId: "gherkin", version: 1, text: formatted },
  });
  assert.deepEqual(await reopenedDiagnostics, { uri: reopened, version: 1, diagnostics: [] });
  await session.shutdown();
});

test("the server returns flat symbols when the client does not support hierarchy", async (context) => {
  const session = await startLanguageServer(context, false);
  const uri = "file:///workspace/flat/git.head-read.feature";
  const diagnostics = waitForDiagnostics(session.connection, uri, 1);
  session.connection.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "gherkin",
      version: 1,
      text: operationFixture("valid/git.head-read.feature"),
    },
  });
  assert.deepEqual(await diagnostics, { uri, version: 1, diagnostics: [] });

  const symbols = await session.connection.sendRequest<SymbolInformation[]>(
    "textDocument/documentSymbol",
    { textDocument: { uri } },
  );
  assert.deepEqual(symbols.map(({ name, containerName }) => ({ name, containerName })), [
    { name: "git.head-read", containerName: undefined },
    { name: "workspaceRoot", containerName: "git.head-read" },
    { name: "project", containerName: "git.head-read" },
    { name: "head", containerName: "git.head-read" },
    { name: "status", containerName: "git.head-read" },
    { name: "headRevision", containerName: "git.head-read" },
    { name: "workingTree", containerName: "git.head-read" },
  ]);
  await session.shutdown();
});

async function assertIgnoredDocument(connection: MessageConnection): Promise<void> {
  const uri = "file:///workspace/ordinary.feature";
  const diagnostics = waitForDiagnostics(connection, uri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "gherkin",
      version: 1,
      text: "# @operation:not-a-tag\nFeature: An ordinary Gherkin document\n",
    },
  });

  assert.deepEqual(await diagnostics, { uri, version: 1, diagnostics: [] });
  assert.deepEqual(
    await connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }),
    [],
  );

  const docStringUri = "file:///workspace/docstring.feature";
  const docStringDiagnostics = waitForDiagnostics(connection, docStringUri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri: docStringUri,
      languageId: "gherkin",
      version: 1,
      text: "Feature: Ordinary\n  Scenario: Text\n    Given a value\n      \"\"\"\n      @operation:not-a-tag\n      \"\"\"\n",
    },
  });
  assert.deepEqual(await docStringDiagnostics, {
    uri: docStringUri,
    version: 1,
    diagnostics: [],
  });

  const scenarioTagUri = "file:///workspace/scenario-tag.feature";
  const scenarioTagDiagnostics = waitForDiagnostics(connection, scenarioTagUri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri: scenarioTagUri,
      languageId: "gherkin",
      version: 1,
      text: "Feature: Ordinary\n  @operation:not-an-operation\n  Scenario: Tagged scenario\n    Given a value\n",
    },
  });
  assert.deepEqual(await scenarioTagDiagnostics, {
    uri: scenarioTagUri,
    version: 1,
    diagnostics: [],
  });
  assert.deepEqual(
    await connection.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: scenarioTagUri },
    }),
    [],
  );
}

async function assertInvalidOperationOpenedDirectly(connection: MessageConnection): Promise<void> {
  const uri = "file:///workspace/invalid/direct-invalid-operation.feature";
  const diagnostics = waitForDiagnostics(connection, uri, 1, (message) => message.diagnostics.length > 0);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "gherkin",
      version: 1,
      text: "@trust-dsl:1 @operation:git.head-read @version:1.0.0\nFeature; broken\n",
    },
  });

  const published = await diagnostics;
  assert.equal(published.diagnostics.length, 1);
  assert.equal(published.diagnostics[0]?.code, "invalid-operation");
  assert.equal(published.diagnostics[0]?.source, "trust-operation");
}

async function assertValidCatalog(connection: MessageConnection): Promise<void> {
  const files = [
    "git.head-read.feature",
    "git.head-read.described.feature",
    "file.package-read.feature",
    "file.license-read.feature",
    "http.status-read.feature",
    "http.text-read.feature",
  ];

  for (const [index, file] of files.entries()) {
    const uri = `file:///workspace/catalog/${file}`;
    const source = operationFixture(`valid/${file}`);
    const diagnostics = waitForDiagnostics(connection, uri, 1);
    connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "gherkin", version: 1, text: source },
    });
    assert.deepEqual(await diagnostics, { uri, version: 1, diagnostics: [] });

    const symbols = await connection.sendRequest<DocumentSymbol[]>(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    );
    assert.equal(symbols.length, 1, file);
    assert.ok(symbols[0]?.name.includes("."), file);
    assert.equal(
      symbols[0]?.detail,
      file === "git.head-read.described.feature"
        ? "Operation 1.0.0 — Reads the checked-out revision of one project below the workspace and tells whether its"
        : "Operation 1.0.0",
      file,
    );
    assert.ok((symbols[0]?.children?.length ?? 0) > 0, file);

    if (index === 0) {
      assert.deepEqual(symbols[0]?.selectionRange, {
        start: { line: 1, character: 24 },
        end: { line: 1, character: 37 },
      });
      assert.deepEqual(symbols[0]?.children?.map(({ name, detail }) => ({ name, detail })), [
        { name: "workspaceRoot", detail: "Environment: directory" },
        { name: "project", detail: "Input: reference one" },
        { name: "head", detail: "Step: shell" },
        { name: "status", detail: "Step: shell" },
        { name: "headRevision", detail: "Produced: reference one" },
        { name: "workingTree", detail: "Produced: string one" },
      ]);
      assert.deepEqual(symbols[0]?.children?.[0]?.selectionRange, {
        start: { line: 7, character: 8 },
        end: { line: 7, character: 21 },
      });
      assert.deepEqual(symbols[0]?.children?.[1]?.selectionRange, {
        start: { line: 10, character: 8 },
        end: { line: 10, character: 15 },
      });
    }
  }
}

async function assertInvalidFixtures(connection: MessageConnection): Promise<void> {
  const errors = JSON.parse(operationFixture("invalid/errors.json")) as Record<string, string>;

  for (const [file, code] of Object.entries(errors)) {
    const uri = `file:///workspace/invalid/${file}`;
    const diagnostics = waitForDiagnostics(connection, uri, 1);
    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "gherkin",
        version: 1,
        text: operationFixture(`invalid/${file}`),
      },
    });
    const published = await diagnostics;
    assert.equal(published.diagnostics.length, 1, file);
    assert.equal(published.diagnostics[0]?.severity, 1, file);
    assert.equal(published.diagnostics[0]?.code, code, file);
    assert.equal(published.diagnostics[0]?.source, "trust-operation", file);
    assert.ok(published.diagnostics[0]?.message, file);
    assertValidRange(published.diagnostics[0]?.range, file);
    const symbols = await connection.sendRequest<DocumentSymbol[]>(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    );
    assert.equal(symbols.length, 1, file);
    assert.ok(symbols[0]?.name, file);
  }
}

async function assertIncrementalDiagnostics(connection: MessageConnection): Promise<void> {
  const uri = "file:///workspace/editing/http.status-read.feature";
  const source = operationFixture("valid/http.status-read.feature");
  const opened = waitForDiagnostics(connection, uri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "gherkin", version: 1, text: source },
  });
  assert.deepEqual(await opened, { uri, version: 1, diagnostics: [] });

  const occurrence = source.lastIndexOf("serviceUrl");
  assert.notEqual(occurrence, -1);
  const start = positionAt(source, occurrence);
  const end = positionAt(source, occurrence + "serviceUrl".length);
  const invalid = waitForDiagnostics(connection, uri, 2, (message) => message.diagnostics.length > 0);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ range: { start, end }, text: "missingUrl" }],
  });
  assert.deepEqual(await invalid, {
    uri,
    version: 2,
    diagnostics: [{
      severity: 1,
      range: {
        start: { line: 14, character: 4 },
        end: { line: 14, character: 62 },
      },
      message: 'HTTP "response" uses undeclared Environment "missingUrl"',
      code: "unknown-environment",
      source: "trust-operation",
    }],
  });
  const symbolsWhileInvalid = await connection.sendRequest<DocumentSymbol[]>(
    "textDocument/documentSymbol",
    { textDocument: { uri } },
  );
  assert.equal(symbolsWhileInvalid[0]?.name, "http.status-read");
  assert.deepEqual(symbolsWhileInvalid[0]?.children?.map(({ name }) => name), [
    "serviceUrl",
    "response",
    "service",
    "status",
  ]);

  const corrected = waitForDiagnostics(connection, uri, 3);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [{
      range: { start, end },
      text: "serviceUrl",
    }],
  });
  assert.deepEqual(await corrected, { uri, version: 3, diagnostics: [] });

  const operationTag = "@operation:http.status-read";
  const operationTagStart = positionAt(source, source.indexOf(operationTag));
  const operationTagEnd = positionAt(source, source.indexOf(operationTag) + operationTag.length);
  const missingIdentity = waitForDiagnostics(connection, uri, 4, (message) => message.diagnostics.length > 0);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 4 },
    contentChanges: [{ range: { start: operationTagStart, end: operationTagEnd }, text: "" }],
  });
  assert.deepEqual((await missingIdentity).diagnostics.map(({ code, message }) => ({ code, message })), [{
    code: "invalid-operation",
    message: "Operation must declare exactly one Operation tag",
  }]);

  const identityRestored = waitForDiagnostics(connection, uri, 5);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 5 },
    contentChanges: [{
      range: { start: operationTagStart, end: operationTagStart },
      text: operationTag,
    }],
  });
  assert.deepEqual(await identityRestored, { uri, version: 5, diagnostics: [] });

  const featureKeyword = "Feature:";
  const featureStart = positionAt(source, source.indexOf(featureKeyword));
  const featureEnd = positionAt(source, source.indexOf(featureKeyword) + featureKeyword.length);
  const invalidGherkin = waitForDiagnostics(connection, uri, 6, (message) => message.diagnostics.length > 0);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 6 },
    contentChanges: [{ range: { start: featureStart, end: featureEnd }, text: "Feature;" }],
  });
  assert.equal((await invalidGherkin).diagnostics[0]?.code, "invalid-operation");

  const gherkinRestored = waitForDiagnostics(connection, uri, 7);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 7 },
    contentChanges: [{ range: { start: featureStart, end: featureEnd }, text: featureKeyword }],
  });
  assert.deepEqual(await gherkinRestored, { uri, version: 7, diagnostics: [] });

  const closed = waitForDiagnostics(connection, uri, 7);
  connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
  assert.deepEqual(await closed, { uri, version: 7, diagnostics: [] });
  assert.deepEqual(
    await connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }),
    [],
  );
}

async function startLanguageServer(
  context: TestContext,
  hierarchicalDocumentSymbols: boolean,
): Promise<LanguageServerSession> {
  const server = spawn(process.execPath, [
    new URL("../../bin/trust-language-server.js", import.meta.url).pathname,
    "--stdio",
  ], { stdio: "pipe" });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk: string) => { stderr += chunk; });
  context.after(() => {
    if (server.exitCode === null) server.kill("SIGTERM");
  });

  const connection = createMessageConnection(
    new StreamMessageReader(server.stdout),
    new StreamMessageWriter(server.stdin),
  );
  connection.listen();
  context.after(() => connection.dispose());

  const initialized = await connection.sendRequest<{
    capabilities: { textDocumentSync?: unknown; documentSymbolProvider?: unknown };
  }>("initialize", {
    processId: null,
    rootUri: null,
    capabilities: hierarchicalDocumentSymbols
      ? {
          textDocument: {
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        }
      : {},
  });
  assert.equal(initialized.capabilities.textDocumentSync, 2);
  assert.equal(initialized.capabilities.documentSymbolProvider, true);
  connection.sendNotification("initialized", {});

  return {
    connection,
    server,
    shutdown: async () => {
      await connection.sendRequest("shutdown");
      connection.sendNotification("exit");
      await once(server, "exit");
      assert.equal(server.exitCode, 0, stderr);
    },
  };
}

function operationFixture(path: string): string {
  return readFileSync(
    new URL(`../../../trust-operation/acceptance/fixtures/${path}`, import.meta.url),
    "utf8",
  );
}

function positionAt(source: string, offset: number): Position {
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function assertValidRange(range: Range | undefined, file: string): void {
  assert.ok(range, file);
  assert.ok(range.start.line >= 0, file);
  assert.ok(range.start.character >= 0, file);
  assert.ok(range.end.line > range.start.line
    || range.end.character > range.start.character, file);
}

function waitForDiagnostics(
  connection: MessageConnection,
  uri: string,
  version: number,
  predicate: (message: PublishDiagnostics) => boolean = () => true,
): Promise<PublishDiagnostics> {
  return waitForNotification(
    connection,
    "textDocument/publishDiagnostics",
    (message: PublishDiagnostics) =>
      message.uri === uri && message.version === version && predicate(message),
  );
}

function waitForNotification<T>(
  connection: MessageConnection,
  method: string,
  predicate: (message: T) => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for ${method}`));
    }, 5_000);
    const subscription = connection.onNotification(method, (message: T) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      subscription.dispose();
      resolve(message);
    });
  });
}

interface Position {
  readonly line: number;
  readonly character: number;
}

interface Range {
  readonly start: Position;
  readonly end: Position;
}

interface LspDiagnostic {
  readonly severity: number;
  readonly range: Range;
  readonly message: string;
  readonly code: string;
  readonly source: string;
}

interface PublishDiagnostics {
  readonly uri: string;
  readonly version?: number;
  readonly diagnostics: readonly LspDiagnostic[];
}

interface DocumentSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children?: readonly DocumentSymbol[];
}

interface SymbolInformation {
  readonly name: string;
  readonly containerName?: string;
  readonly location: { readonly uri: string; readonly range: Range };
}

interface LanguageServerSession {
  readonly connection: MessageConnection;
  readonly server: ChildProcessWithoutNullStreams;
  readonly shutdown: () => Promise<void>;
}
