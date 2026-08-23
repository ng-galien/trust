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
import { compileOperation } from "@trust/operation";
import { operationLanguage } from "@trust/operation/language";
import { compileProcedure } from "@trust/procedure";
import { CompletionItemKind } from "vscode-languageserver/node";

test("the Microsoft LSP server exposes the Operation language through standard JSON-RPC", async (context) => {
  const session = await startLanguageServer(context);
  const { connection } = session;

  await assertIgnoredDocument(connection);
  await assertInvalidOperationOpenedDirectly(connection);
  await assertValidCatalog(connection);
  await assertDefaultTemplates(connection);
  await assertInvalidFixtures(connection);
  await assertIncrementalDiagnostics(connection);
  await assertProcedureEditing(connection);

  await session.shutdown();
});

test("the server accepts step continuation lines and formats long steps onto them", async (context) => {
  const session = await startLanguageServer(context);
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
      const stepsPosition = positionAt(source, source.indexOf("steps.head") + "steps.".length);
      const steps = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
        textDocument: { uri }, position: stepsPosition,
      });
      assert.deepEqual(steps.map(({ label }) => label).sort(), ["head", "status"]);

      const resultPosition = positionAt(source, source.indexOf("steps.head.stdout") + "steps.head.".length);
      const shellResult = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
        textDocument: { uri }, position: resultPosition,
      });
      assert.deepEqual(shellResult.map(({ label }) => label).sort(), ["exitCode", "stderr", "stdout"]);

      const jsonataPosition = positionAt(source, source.indexOf("$trim"));
      const jsonata = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
        textDocument: { uri }, position: jsonataPosition,
      });
      assert.deepEqual(
        jsonata.map(({ label }) => label).filter((label) => label.startsWith("$")).sort(),
        operationLanguage.jsonata.functions.map((name) => `$${name}`).sort(),
      );

      const semantic = await connection.sendRequest<SemanticTokens>("textDocument/semanticTokens/full", {
        textDocument: { uri },
      });
      assert.ok(semantic.data.length > 0);
    }
  }
}

async function assertDefaultTemplates(connection: MessageConnection): Promise<void> {
  const operationUri = "file:///workspace/new-operation.feature";
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: operationUri, languageId: "trust-operation", version: 1, text: "" },
  });
  const operationItems = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: operationUri }, position: { line: 0, character: 0 },
  });
  const operationTemplate = operationItems.find(({ label }) => label === "Operation feature")?.insertText;
  assert.ok(operationTemplate);
  compileOperation({ source: operationTemplate });

  const procedureUri = "file:///workspace/new-procedure.feature";
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: procedureUri, languageId: "trust-procedure", version: 1, text: "" },
  });
  const procedureItems = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: procedureUri }, position: { line: 0, character: 0 },
  });
  const procedureTemplate = procedureItems.find(({ label }) => label === "Procedure feature")?.insertText;
  assert.ok(procedureTemplate);
  compileProcedure({ source: procedureTemplate, operations: [compileOperation({ source: operationFixture("valid/git.head-read.feature") })] });
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
        end: { line: 14, character: 79 },
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

async function assertProcedureEditing(connection: MessageConnection): Promise<void> {
  const uri = "file:///workspace/procedures/git-status.feature";
  const source = procedureFixture("00-git-status.feature");
  const opened = waitForDiagnostics(connection, uri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "gherkin", version: 1, text: source },
  });
  assert.deepEqual(await opened, { uri, version: 1, diagnostics: [] });

  const optionalUri = "file:///workspace/procedures/optional-agent-declaration.feature";
  const optionalSource = source.replace(
    'Given one reference "repository"',
    'Given one reference "repository" declared optionally by agent',
  );
  const optionalDiagnostics = waitForDiagnostics(connection, optionalUri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: optionalUri, languageId: "trust-procedure", version: 1, text: optionalSource },
  });
  assert.deepEqual(await optionalDiagnostics, { uri: optionalUri, version: 1, diagnostics: [] });

  const completionUri = "file:///workspace/procedures/incomplete-optional-agent-declaration.feature";
  const completionSource = source.replace(
    'Given one reference "repository"',
    'Given one reference "repository" declared ',
  );
  const completionDiagnostics = waitForDiagnostics(connection, completionUri, 1, (message) => message.diagnostics.length > 0);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: completionUri, languageId: "trust-procedure", version: 1, text: completionSource },
  });
  await completionDiagnostics;
  const optionalCompletions = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: completionUri },
    position: positionAt(completionSource, completionSource.indexOf("declared ") + "declared ".length),
  });
  const optionalCompletion = optionalCompletions.find(({ label, kind }) => label === "optionally" && kind === CompletionItemKind.Keyword);
  assert.ok(optionalCompletion);
  const completionOffset = completionSource.indexOf("declared ") + "declared ".length;
  const completedSource = completionSource.slice(0, completionOffset)
    + (optionalCompletion.insertText ?? optionalCompletion.label)
    + completionSource.slice(completionOffset);
  compileProcedure({
    source: completedSource,
    operations: [compileOperation({ source: operationFixture("valid/git.head-read.feature") })],
  });

  const requiredUri = "file:///workspace/procedures/required-agent-declaration.feature";
  const requiredSource = source.replace(
    'Given one reference "repository"',
    'Given one reference "repository" declared by agent',
  );
  const requiredDiagnostics = waitForDiagnostics(connection, requiredUri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: requiredUri, languageId: "trust-procedure", version: 1, text: requiredSource },
  });
  assert.deepEqual(await requiredDiagnostics, { uri: requiredUri, version: 1, diagnostics: [] });
  const beforeByAgent = requiredSource.indexOf("declared by agent") + "declared ".length;
  const existingClauseCompletions = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: requiredUri },
    position: positionAt(requiredSource, beforeByAgent),
  });
  const existingClauseCompletion = existingClauseCompletions.find(({ label }) => label === "optionally");
  assert.ok(existingClauseCompletion);
  const optionalizedSource = requiredSource.slice(0, beforeByAgent)
    + (existingClauseCompletion.insertText ?? existingClauseCompletion.label)
    + requiredSource.slice(beforeByAgent);
  compileProcedure({
    source: optionalizedSource,
    operations: [compileOperation({ source: operationFixture("valid/git.head-read.feature") })],
  });
  const afterAgent = requiredSource.indexOf("by agent") + "by agent".length;
  const misplacedCompletions = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: requiredUri },
    position: positionAt(requiredSource, afterAgent),
  });
  assert.ok(!misplacedCompletions.some(({ label }) => label === "optionally"));

  const optionalSemantic = await connection.sendRequest<SemanticTokens>("textDocument/semanticTokens/full", {
    textDocument: { uri: optionalUri },
  });
  assertSemanticTokenAt(optionalSemantic, positionAt(optionalSource, optionalSource.indexOf("optionally")), "optionally".length);

  const operationPosition = positionAt(source, source.indexOf('Operation "') + 'Operation "'.length);
  const operations = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri }, position: operationPosition,
  });
  assert.ok(operations.some(({ label }) => label === "git.head-read"));

  const factPosition = positionAt(source, source.indexOf("fact.") + "fact.".length);
  const facts = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri }, position: factPosition,
  });
  assert.deepEqual(facts.map(({ label }) => label).sort(), ["headRevision", "workingTree"]);

  const roots = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri }, position: positionAt(source, source.indexOf("fact.")),
  });
  assert.ok(roots.some(({ label }) => label === "fail"));
  assert.ok(!roots.some(({ label }) => label === "failed"));

  const folds = await connection.sendRequest<FoldingRange[]>("textDocument/foldingRange", {
    textDocument: { uri },
  });
  assert.ok(folds.some(({ startLine, endLine }) => startLine === 14 && endLine === 17));

  const symbols = await connection.sendRequest<DocumentSymbol[]>("textDocument/documentSymbol", {
    textDocument: { uri },
  });
  assert.equal(symbols[0]?.name, "git-status");
  assert.ok(symbols[0]?.children?.some(({ name, detail }) => name === "repository status" && detail === "Check"));

  const occurrence = source.indexOf("workingTree");
  const start = positionAt(source, occurrence);
  const end = positionAt(source, occurrence + "workingTree".length);
  const invalid = waitForDiagnostics(connection, uri, 2, (message) => message.diagnostics.length > 0);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ range: { start, end }, text: "missingField" }],
  });
  const published = await invalid;
  assert.equal(published.diagnostics[0]?.code, "unknown-field");
  assert.equal(published.diagnostics[0]?.source, "trust-procedure");

  const restored = waitForDiagnostics(connection, uri, 3);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [{ range: { start, end: positionAt(source, occurrence + "missingField".length) }, text: "workingTree" }],
  });
  assert.deepEqual(await restored, { uri, version: 3, diagnostics: [] });

  const naturalUri = "file:///workspace/procedures/natural-role.feature";
  const naturalSource = source
    .replace('Given one reference "repository"', 'Given one reference "repository"\n    And one reference "baseline revision"')
    .replace('fail("the repository has no local changes")', 'fail(`No changes since ${context["baseline revision"]}`)');
  const naturalDiagnostics = waitForDiagnostics(connection, naturalUri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: naturalUri, languageId: "trust-procedure", version: 1, text: naturalSource },
  });
  assert.deepEqual(await naturalDiagnostics, { uri: naturalUri, version: 1, diagnostics: [] });
  const contextEnd = naturalSource.indexOf("context[") + "context".length;
  const roles = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: naturalUri }, position: positionAt(naturalSource, contextEnd),
  });
  assert.deepEqual(roles.find(({ label }) => label === "baseline revision")?.textEdit, {
    range: { start: positionAt(naturalSource, contextEnd), end: positionAt(naturalSource, contextEnd) },
    newText: '["baseline revision"]',
  });

  const incompleteUri = "file:///workspace/procedures/incomplete-natural-role.feature";
  const completeAccessor = 'context["baseline revision"]';
  const incompleteAccessor = 'context["base';
  const incompleteSource = naturalSource.replace(completeAccessor, incompleteAccessor);
  const incompleteDiagnostics = waitForDiagnostics(connection, incompleteUri, 1, (message) => message.diagnostics.length > 0);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: incompleteUri, languageId: "trust-procedure", version: 1, text: incompleteSource },
  });
  await incompleteDiagnostics;
  const incompleteEnd = incompleteSource.indexOf(incompleteAccessor) + incompleteAccessor.length;
  const incompleteRoles = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: incompleteUri }, position: positionAt(incompleteSource, incompleteEnd),
  });
  assert.deepEqual(incompleteRoles.find(({ label }) => label === "baseline revision")?.textEdit, {
    range: {
      start: positionAt(incompleteSource, incompleteSource.indexOf(incompleteAccessor) + "context".length),
      end: positionAt(incompleteSource, incompleteEnd),
    },
    newText: '["baseline revision"]',
  });

  const multipleUri = "file:///workspace/procedures/multiple-errors.feature";
  const multipleSource = source.replace("fact.workingTree", "fact.missingOne").trimEnd() + `

    And Check "second status" runs Operation "git.head-read" on "repository" as Input "project" and must establish "the second observation is valid"
      """js
      fact.missingTwo === "dirty" ||
      fail("the second observation is invalid")
      """
`;
  const multipleDiagnostics = waitForDiagnostics(connection, multipleUri, 1, (message) => message.diagnostics.length === 2);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: multipleUri, languageId: "trust-procedure", version: 1, text: multipleSource },
  });
  assert.deepEqual((await multipleDiagnostics).diagnostics.map(({ code, message }) => ({ code, message })), [
    { code: "unknown-field", message: 'Operation "git.head-read" produces no field "missingOne"' },
    { code: "unknown-field", message: 'Operation "git.head-read" produces no field "missingTwo"' },
  ]);
}

async function startLanguageServer(context: TestContext): Promise<LanguageServerSession> {
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
    capabilities: {
      textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
    },
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

function procedureFixture(path: string): string {
  return readFileSync(new URL(`../../../../assets/procedures/${path}`, import.meta.url), "utf8");
}

function positionAt(source: string, offset: number): Position {
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function assertSemanticTokenAt(tokens: SemanticTokens, expected: Position, length: number): void {
  let line = 0;
  let character = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    const lineDelta = tokens.data[index] ?? 0;
    line += lineDelta;
    character = lineDelta === 0 ? character + (tokens.data[index + 1] ?? 0) : (tokens.data[index + 1] ?? 0);
    if (line === expected.line && character === expected.character && tokens.data[index + 2] === length) {
      assert.equal(tokens.data[index + 3], 1, "optionally must be a keyword semantic token");
      return;
    }
  }
  assert.fail(`No semantic token at ${expected.line}:${expected.character}`);
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

interface CompletionItem { readonly label: string; readonly kind?: number; readonly insertText?: string; readonly textEdit?: { readonly range: Range; readonly newText: string } }
interface FoldingRange { readonly startLine: number; readonly endLine: number }
interface SemanticTokens { readonly data: readonly number[] }

interface LanguageServerSession {
  readonly connection: MessageConnection;
  readonly server: ChildProcessWithoutNullStreams;
  readonly shutdown: () => Promise<void>;
}
