import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { type TemplateParameter, templateDocumentContextMethod } from "@trust/extension-sdk";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const source = `@trust-dsl:1 @procedure:{{procedure}} @version:{{version}}
Feature: Template language
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe the repository. | Modify external state. |
    And one reference "repository"
  @scenario:observe
  Scenario: Observe
    Then Check "observe" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "clean"
      """js
      fact.workingTree === "clean" || fail("dirty")
      """
`;
const parameters: TemplateParameter[] = [
  { name: "procedure", description: "Identifier", defaultValue: "template-language" },
  { name: "version", description: "Version", defaultValue: "1.0.0" },
];
type Position = { line: number; character: number };
type Diagnostic = { message: string; severity?: number; code?: string; range: { start: Position; end: Position } };
type Completion = { label: string; textEdit?: { range: { start: Position; end: Position }; newText: string } };
type Diagnostics = { uri: string; version: number; diagnostics: Diagnostic[] };

async function session(context: TestContext) {
  const server = spawn(
    process.execPath,
    [new URL("../../bin/trust-language-server.js", import.meta.url).pathname, "--stdio"],
    { stdio: "pipe" },
  );
  const connection = createMessageConnection(
    new StreamMessageReader(server.stdout),
    new StreamMessageWriter(server.stdin),
  );
  context.after(() => {
    connection.dispose();
    if (server.exitCode === null) server.kill("SIGTERM");
  });
  connection.listen();
  await connection.sendRequest("initialize", { processId: null, rootUri: null, capabilities: {} });
  await connection.sendNotification("initialized", {});
  const operation = readFileSync(
    new URL("../../../trust-operation/acceptance/fixtures/valid/git.head-read.feature", import.meta.url),
    "utf8",
  );
  await open(connection, "file:///catalog/git.head-read.feature", operation);
  return connection;
}
function diagnostics(connection: MessageConnection, uri: string, version: number): Promise<Diagnostics> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listener.dispose();
      reject(new Error(`Missing diagnostics for ${uri} version ${version}`));
    }, 5_000);
    const listener = connection.onNotification("textDocument/publishDiagnostics", (message: Diagnostics) => {
      if (message.uri !== uri || message.version !== version) return;
      clearTimeout(timer);
      listener.dispose();
      resolve(message);
    });
  });
}
async function open(
  connection: MessageConnection,
  uri: string,
  text: string,
  templateParameters?: TemplateParameter[],
) {
  if (templateParameters)
    await connection.sendNotification(templateDocumentContextMethod, { uri, parameters: templateParameters });
  const result = diagnostics(connection, uri, 1);
  await connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "trust-procedure", version: 1, text },
  });
  return result;
}
async function change(connection: MessageConnection, uri: string, text: string, version: number) {
  const result = diagnostics(connection, uri, version);
  await connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
  return result;
}
function at(text: string, offset: number): Position {
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}
function complete(connection: MessageConnection, uri: string, text: string, after: string) {
  return connection.sendRequest<Completion[]>("textDocument/completion", {
    textDocument: { uri },
    position: at(text, text.indexOf(after) + after.length),
  });
}

test("template defaults enable real typed completion and mapped diagnostics without changing original source", async (context) => {
  const connection = await session(context);
  const uri = "inmemory://trust/templates/defaulted.feature";
  assert.deepEqual((await open(connection, uri, source, parameters)).diagnostics, []);
  const completions = await complete(connection, uri, source, "fact.");
  assert.ok(completions.some(({ label }) => label === "workingTree"));
  assert.ok(completions.some(({ label }) => label === "headRevision"));
  for (const completion of completions) {
    if (completion.textEdit)
      assert.equal(completion.textEdit.range.start.line, at(source, source.indexOf("fact.")).line);
  }
  const invalid = source.replace("fact.workingTree", "fact.missingField");
  const invalidDiagnostics = (await change(connection, uri, invalid, 2)).diagnostics;
  const fieldError = invalidDiagnostics.find(({ message }) => message.includes('produces no field "missingField"'));
  assert.ok(fieldError, JSON.stringify(invalidDiagnostics));
  assert.equal(fieldError.range.start.line, at(invalid, invalid.indexOf('"""js')).line);
  assert.deepEqual((await change(connection, uri, source, 3)).diagnostics, []);
  const rendered = source.replace("{{procedure}}", "rendered-template").replace("{{version}}", "1.0.0");
  const renderedUri = "inmemory://trust/templates/rendered.feature";
  assert.deepEqual((await open(connection, renderedUri, rendered, [])).diagnostics, []);
  assert.ok((await complete(connection, renderedUri, rendered, "fact.")).some(({ label }) => label === "workingTree"));
});

test("scope fragments complete and format without exposing scaffold; unresolved parameters remain diagnostics", async (context) => {
  const connection = await session(context);
  const uri = "inmemory://trust/templates/scope.feature";
  const fragment =
    "    Given Procedure scope   \n      | check | authorized | forbidden |\n      | all | Ask {{authority}}. | Change decisions. |\n";
  const params = [{ name: "authority", description: "Decision authority", defaultValue: "the operator" }];
  assert.deepEqual((await open(connection, uri, fragment, params)).diagnostics, []);
  const items = await complete(connection, uri, fragment, "Given ");
  assert.ok(
    items.some(({ label }) => label === "Procedure scope"),
    JSON.stringify(items),
  );
  const edits = await connection.sendRequest<Array<{ newText: string }>>("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  });
  assert.equal(edits.length, 1, "Format must change deliberately unformatted source");
  for (const edit of edits) {
    assert.notEqual(edit.newText, fragment);
    assert.ok(!edit.newText.includes("the operator"), "formatting must not substitute defaults");
    assert.ok(!edit.newText.includes("Feature:"), edit.newText);
    assert.ok(!edit.newText.includes("@procedure:"), edit.newText);
    assert.ok(edit.newText.includes("{{authority}}"), edit.newText);
  }
  const unresolvedUri = "inmemory://trust/templates/unresolved.feature";
  const unresolved = (
    await open(connection, unresolvedUri, fragment, [{ name: "authority", description: "Decision authority" }])
  ).diagnostics;
  assert.ok(
    unresolved.some(
      ({ message, code, severity }) =>
        code === "template-parameter-unresolved" && severity === 2 && message.includes("authority"),
    ),
    JSON.stringify(unresolved),
  );
  assert.ok(
    unresolved.every(({ message }) => !message.includes("English Feature")),
    JSON.stringify(unresolved),
  );
});

test("projected Operation templates never enter the ordinary authoring catalog", async (context) => {
  const connection = await session(context);
  const operation = readFileSync(
    new URL("../../../trust-operation/acceptance/fixtures/valid/git.head-read.feature", import.meta.url),
    "utf8",
  ).replace("@operation:git.head-read", "@operation:{{name}}");
  await open(connection, "inmemory://trust/templates/operation.feature", operation, [
    { name: "name", description: "Operation identity", defaultValue: "template.synthetic" },
  ]);
  const uri = "file:///ordinary/procedure.feature";
  const ordinary = source.replace("{{procedure}}", "ordinary-procedure").replace("{{version}}", "1.0.0");
  await open(connection, uri, ordinary);
  const items = await complete(connection, uri, ordinary, 'runs Operation "');
  assert.ok(
    items.some(({ label }) => label.includes("git.head-read")),
    JSON.stringify(items),
  );
  assert.ok(
    items.every(({ label }) => !label.includes("template.synthetic")),
    JSON.stringify(items),
  );
});

test("multiline defaults and placeholders before a cursor preserve physical diagnostic and completion positions", async (context) => {
  const connection = await session(context);
  const uri = "inmemory://trust/templates/mapped.feature";
  const mapped = source
    .replace("Feature: Template language", "Feature: {{title}}")
    .replace('fact.workingTree === "clean"', 'fact.workingTree === "{{status}}" && fact.workingTree === "clean"');
  const params = [
    ...parameters,
    { name: "title", description: "Title", defaultValue: "Mapped title\n  Multiline description" },
    { name: "status", description: "Working tree", defaultValue: "clean" },
  ];
  assert.deepEqual((await open(connection, uri, mapped, params)).diagnostics, []);
  const cursor = at(mapped, mapped.lastIndexOf("fact.") + "fact.".length);
  const items = await connection.sendRequest<Completion[]>("textDocument/completion", {
    textDocument: { uri },
    position: cursor,
  });
  const field = items.find(({ label }) => label === "workingTree");
  assert.ok(field, JSON.stringify(items));
  assert.ok(field.textEdit, "typed completion supplies an edit at the original cursor");
  assert.deepEqual(field.textEdit.range.start, cursor);
  const invalid = mapped.replace("&& fact.workingTree", "&& fact.missingField");
  const errors = (await change(connection, uri, invalid, 2)).diagnostics;
  const error = errors.find(({ message }) => message.includes('produces no field "missingField"'));
  assert.ok(error, JSON.stringify(errors));
  assert.equal(error.range.start.line, at(invalid, invalid.indexOf('"""js')).line);
});

test("invalid context replaces previously valid defaults instead of retaining stale typed assistance", async (context) => {
  const connection = await session(context);
  const uri = "inmemory://trust/templates/context-validation.feature";
  assert.deepEqual((await open(connection, uri, source, parameters)).diagnostics, []);
  for (const invalid of [
    [...parameters, { name: "procedure", description: "Duplicate", defaultValue: "other-procedure" }],
    [{ name: "", description: "Blank", defaultValue: "other-procedure" }],
  ]) {
    const notification = diagnostics(connection, uri, 1);
    await connection.sendNotification(templateDocumentContextMethod, { uri, parameters: invalid });
    const errors = (await notification).diagnostics;
    assert.ok(
      errors.some(({ code }) => code === "template-context-invalid"),
      JSON.stringify(errors),
    );
    const items = await complete(connection, uri, source, "fact.");
    assert.ok(
      items.every(({ label }) => label !== "workingTree" && label !== "headRevision"),
      JSON.stringify(items),
    );
    const restored = diagnostics(connection, uri, 1);
    await connection.sendNotification(templateDocumentContextMethod, { uri, parameters });
    assert.deepEqual((await restored).diagnostics, []);
  }
});

test("oversized template projection reports its bound and keeps the public server responsive", async (context) => {
  const connection = await session(context);
  const uri = "inmemory://trust/templates/bounded.feature";
  const oversized = source.replace(
    "Feature: Template language",
    "Feature: {{large}}{{large}}{{large}}{{large}}{{large}}{{large}}",
  );
  const errors = (
    await open(connection, uri, oversized, [
      ...parameters,
      { name: "large", description: "Large title", defaultValue: "x".repeat(200_000) },
    ])
  ).diagnostics;
  assert.ok(
    errors.some(({ code }) => code === "template-projection-limit"),
    JSON.stringify(errors),
  );
  const healthyUri = "inmemory://trust/templates/after-limit.feature";
  assert.deepEqual((await open(connection, healthyUri, source, parameters)).diagnostics, []);
  assert.ok((await complete(connection, healthyUri, source, "fact.")).some(({ label }) => label === "workingTree"));
});

test("scope fragments preserve leading comments and canonical column diagnostics at physical source lines", async (context) => {
  const connection = await session(context);
  const uri = "inmemory://trust/templates/commented-scope.feature";
  const fragment =
    "# Template policy fragment\n\n    Given Procedure scope\n      | check | authorized | forbidden |\n      | all | Read the repository. | Change decisions. |\n";
  assert.deepEqual((await open(connection, uri, fragment, [])).diagnostics, []);
  assert.ok((await complete(connection, uri, fragment, "Given ")).some(({ label }) => label === "Procedure scope"));
  const invalid = fragment.replace("| authorized |", "| permission |");
  const errors = (await change(connection, uri, invalid, 2)).diagnostics;
  const columnError = errors.find(
    ({ code, message }) => code === "invalid-procedure" && message.includes("scope columns"),
  );
  assert.ok(columnError, JSON.stringify(errors));
  assert.equal(columnError.range.start.line, 2);
  assert.deepEqual((await change(connection, uri, fragment, 3)).diagnostics, []);
});

test("formatting a complete template reflows original steps while preserving parameter placeholders", async (context) => {
  const connection = await session(context);
  const uri = "inmemory://trust/templates/format-complete.feature";
  const unformatted = source.replace(' on "repository"', '\n                   on "repository"');
  assert.deepEqual((await open(connection, uri, unformatted, parameters)).diagnostics, []);
  const edits = await connection.sendRequest<Array<{ newText: string }>>("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  });
  assert.equal(edits.length, 1, "Format must normalize the over-indented continuation");
  const formatted = edits[0]?.newText;
  assert.ok(formatted);
  assert.notEqual(formatted, unformatted);
  assert.ok(formatted.includes("@procedure:{{procedure}} @version:{{version}}"));
  assert.ok(!formatted.includes("@procedure:template-language"));
  assert.ok(formatted.includes('\n        as Input "project"'), formatted);
  assert.deepEqual((await change(connection, uri, formatted, 2)).diagnostics, []);
});

test("scope fragments report an unclosed doc string on open and edit, then clear it after repair", async (context) => {
  const connection = await session(context);
  const valid =
    "# Scope fragment fixture\n    Given Procedure scope\n      | check | authorized | forbidden |\n      | all | Read the repository. | Change decisions. |\n";
  const invalid = `${valid}      """\n      Unclosed fragment doc string\n`;
  const assertOriginalSyntaxRange = (messages: Diagnostic[]) => {
    const syntax = messages.find(({ code }) => code === "template-fragment-syntax");
    assert.ok(syntax, JSON.stringify(messages));
    assert.equal(syntax.severity, 1);
    assert.deepEqual(syntax.range.start, { line: 0, character: 0 });
    assert.deepEqual(
      syntax.range.end,
      at(invalid, invalid.length),
      "diagnostic range covers only the original source, without synthetic containment",
    );
  };
  const openedUri = "inmemory://trust/templates/invalid-scope-open.feature";
  assertOriginalSyntaxRange((await open(connection, openedUri, invalid, [])).diagnostics);
  assert.deepEqual((await change(connection, openedUri, valid, 2)).diagnostics, []);
  const editedUri = "inmemory://trust/templates/invalid-scope-edit.feature";
  assert.deepEqual((await open(connection, editedUri, valid, [])).diagnostics, []);
  assertOriginalSyntaxRange((await change(connection, editedUri, invalid, 2)).diagnostics);
  assert.deepEqual((await change(connection, editedUri, valid, 3)).diagnostics, []);
});

test("scope fragment boundaries and independent errors remain visible with unresolved values", async (context) => {
  const connection = await session(context);
  const fragment =
    "Given Procedure scope\n  | check | authorized | forbidden |\n  | all | Read {{target}}. | Change state. |\n";
  for (const [index, trailing] of [
    "And this is not a valid domain declaration\n",
    "Scenario: Extra\n  Then invalid check\n",
  ].entries()) {
    const uri = `inmemory://trust/templates/trailing-${index}.feature`;
    const errors = (await open(connection, uri, fragment + trailing, [{ name: "target", description: "Target" }]))
      .diagnostics;
    assert.ok(
      errors.some(({ code }) => code === "template-parameter-unresolved"),
      JSON.stringify(errors),
    );
    const unsupported = errors.find(({ message }) => message.includes("Only one Procedure scope step"));
    assert.ok(unsupported, JSON.stringify(errors));
    assert.equal(unsupported.range.start.line, 3);
    const restored = await change(connection, uri, fragment, 2);
    assert.ok(restored.diagnostics.every(({ code }) => code === "template-parameter-unresolved"));
  }
});

test("materialized text preserves literal placeholders and canonical diagnostics without entering catalogs", async (context) => {
  const connection = await session(context);
  const uri = "inmemory://trust/templates/literal-rendered.feature";
  const rendered = source
    .replace("{{procedure}}", "literal-rendered")
    .replace("{{version}}", "1.0.0")
    .replace("Observe the repository.", "Read {{literal}}.");
  await connection.sendNotification(templateDocumentContextMethod, { uri, parameters: [], materialized: true });
  assert.deepEqual((await open(connection, uri, rendered)).diagnostics, []);
  assert.ok((await complete(connection, uri, rendered, "fact.")).some(({ label }) => label === "workingTree"));
  const errors = (await change(connection, uri, rendered.replace("fact.workingTree", "fact.missingField"), 2))
    .diagnostics;
  assert.ok(
    errors.some(({ message }) => message.includes('produces no field "missingField"')),
    JSON.stringify(errors),
  );
  assert.ok(errors.every(({ code }) => !code?.startsWith("template-")));
  const operation = readFileSync(
    new URL("../../../trust-operation/acceptance/fixtures/valid/git.head-read.feature", import.meta.url),
    "utf8",
  ).replace("@operation:git.head-read", "@operation:materialized.private");
  const operationUri = "inmemory://trust/templates/materialized-operation.feature";
  await connection.sendNotification(templateDocumentContextMethod, {
    uri: operationUri,
    parameters: [],
    materialized: true,
  });
  await open(connection, operationUri, operation);
  const ordinaryUri = "file:///ordinary/materialized-catalog.feature";
  await open(connection, ordinaryUri, rendered);
  const items = await complete(connection, ordinaryUri, rendered, 'runs Operation "');
  assert.ok(items.some(({ label }) => label.includes("git.head-read")));
  assert.ok(items.every(({ label }) => !label.includes("materialized.private")));
  const invalidClear = diagnostics(connection, uri, 2);
  await connection.sendNotification(templateDocumentContextMethod, { uri, parameters: null, materialized: "invalid" });
  assert.ok((await invalidClear).diagnostics.some(({ code }) => code === "template-context-invalid"));
});
