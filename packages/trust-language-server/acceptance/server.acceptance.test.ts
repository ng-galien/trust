import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { compileOperation } from "@trust/operation";
import { operationLanguage } from "@trust/operation/language";
import { compileProcedure } from "@trust/procedure";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { CompletionItemKind } from "vscode-languageserver/node";

const semanticTokenTypes = [
  "comment",
  "tag",
  "keyword",
  "keyword-control",
  "title",
  "type",
  "verb",
  "string",
  "number",
  "delimiter",
  "table-header",
  "table-cell",
  "function",
  "root",
  "operator",
  "variable",
  "cardinality",
  "declaration",
  "reference",
  "property",
  "boolean",
] as const;

test("the Microsoft LSP server exposes the Operation language through standard JSON-RPC", async (context) => {
  const session = await startLanguageServer(context);
  const { connection } = session;

  await assertIgnoredDocument(connection);
  await assertInvalidOperationOpenedDirectly(connection);
  await assertValidCatalog(connection);
  await assertOperationCompletionCompiles(connection);
  await assertDefaultTemplates(connection);
  await assertInvalidFixtures(connection);
  await assertIncrementalDiagnostics(connection);
  await assertProcedureEditing(connection);
  await assertNumericSemanticToken(connection);

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

  const edits = await session.connection.sendRequest<Array<{ newText: string }>>("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  });
  assert.equal(edits.length, 1);
  const formatted = edits[0]!.newText;
  assert.ok(
    formatted.includes(
      'When Shell "head" runs "git" with cwd from Environment "workspaceRoot"\n        and Input "project"',
    ),
    formatted,
  );

  const reopened = "file:///workspace/format/continued.feature";
  const reopenedDiagnostics = waitForDiagnostics(session.connection, reopened, 1);
  session.connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: reopened, languageId: "gherkin", version: 1, text: formatted },
  });
  assert.deepEqual(await reopenedDiagnostics, { uri: reopened, version: 1, diagnostics: [] });
  const continuedInput = await session.connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: reopened },
    position: positionAt(formatted, formatted.indexOf('"project"') + 1),
  });
  assert.deepEqual(
    continuedInput.map(({ label }) => label),
    ["project"],
  );
  const semantic = await session.connection.sendRequest<SemanticTokens>("textDocument/semanticTokens/full", {
    textDocument: { uri: reopened },
  });
  const continuedType = formatted.indexOf('Input "project"', formatted.indexOf("\n        and Input"));
  assert.ok(continuedType > 0, "formatted continuation carries the Input type");
  assertSemanticTokenAt(semantic, positionAt(formatted, continuedType), "Input".length, "type");
  await session.shutdown();
});

test("stdio hover and document links resolve canonical Operation and exact-version Procedure references safely", async (context) => {
  const session = await startLanguageServer(context);
  const { connection } = session;
  const open = async (uri: string, text: string, version = 1) => {
    const diagnostics = waitForDiagnostics(connection, uri, version);
    connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "gherkin", version, text },
    });
    await diagnostics;
  };
  const operationUri = "file:///workspace/hover/operation.feature";
  const operation = operationFixture("valid/git.head-read.feature").replace(
    /Feature: [^\n]*/,
    "Feature: [unsafe](command:bad) <script>title</script>\n\n  [description](https://evil.invalid) and `command:bad`\n  Unicode équipe龍🎲\tkept\u0000\u0008\u000b\u000c\u000e\u001f\u007f clean\r\n  next line",
  );
  await open(operationUri, operation);
  const child = (version: string) => `@trust-dsl:1 @procedure:hover-child @version:${version}
Feature: Child ${version} [unsafe](command:bad)
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe the repository. | Modify external state. |
    And one reference "repository"
  @scenario:observe
  Scenario: Observe
    Then Check "child observation" runs Operation "git.head-read@*" on "repository" as Input "project" and must establish "observed"
      """js
      fact.workingTree === "clean" || fail("not clean")
      """
`;
  await open("file:///workspace/hover/child-v1.feature", child("1.0.0"));
  await open("file:///workspace/hover/child-v2.feature", child("2.0.0"));
  const uri = "file:///workspace/hover/parent.feature";
  const source = `@trust-dsl:1 @procedure:hover-parent @version:1.0.0
Feature: References
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe the repository. | Modify external state. |
    And one reference "repository"
  @scenario:observe
  Scenario: Observe
    # Then Invocation "fake" runs Procedure "hover-child@1.0.0" and must establish "fake"
    Then Check "git.head-read" runs Operation
        "git.head-read@^1.0.0" on "repository" as Input "project" and must establish "observed"
      """js
      fact.workingTree === "clean" || fail('Operation "git.head-read"')
      """
    And Invocation "first" runs Procedure
        "hover-child@^1.0.0" on "repository" as Input "repository" and must establish "first done"
    And Invocation "second" runs Procedure "hover-child@2.0.0" on "repository" as Input "repository" and must establish "second done"
    And Invocation "unknown" runs Procedure "hover-child@9.0.0" on "repository" as Input "repository" and must establish "unknown"
    And Check "unresolved" runs Operation "command:forged@*" on "repository" as Input "project" and must establish "unresolved"
    And Check "malformed" runs Operation "git.head-read@*" unexpected tail
`;
  await open(uri, source);
  const links = await connection.sendRequest<Array<{ target: string; range: { start: Position; end: Position } }>>(
    "textDocument/documentLink",
    { textDocument: { uri } },
  );
  assert.deepEqual(
    links.map((value) => value.target),
    [
      "trust-resource://operation/git.head-read?version=1.0.0",
      "trust-resource://procedure/hover-child?version=1.0.0",
      "trust-resource://procedure/hover-child?version=2.0.0",
    ],
  );
  const offsets = [
    source.indexOf('"git.head-read@^1.0.0" on') + 1,
    source.indexOf('"hover-child@^1.0.0" on') + 1,
    source.indexOf('"hover-child@2.0.0" on') + 1,
  ];
  for (const [index, link] of links.entries()) {
    const name = index === 0 ? "git.head-read@^1.0.0" : index === 1 ? "hover-child@^1.0.0" : "hover-child@2.0.0";
    assert.deepEqual(link.range, {
      start: positionAt(source, offsets[index]!),
      end: positionAt(source, offsets[index]! + name.length),
    });
    const hover = await connection.sendRequest<{ contents: { kind: string; value: string }; range: unknown }>(
      "textDocument/hover",
      { textDocument: { uri }, position: link.range.start },
    );
    assert.equal(hover.contents.kind, "markdown");
    assert.deepEqual(hover.range, link.range);
    assert.ok(hover.contents.value.includes(`](${link.target})`));
    assert.ok(!hover.contents.value.includes("](" + "command:"));
    assert.ok(!hover.contents.value.includes("<script>"));
    assert.ok(!hover.contents.value.includes("](https://evil.invalid)"));
    if (index === 0) {
      assert.ok(hover.contents.value.includes("équipe龍🎲\tkept clean"));
      assert.ok(hover.contents.value.includes("\n"));
      for (const code of [0, 8, 11, 12, 14, 31, 127]) {
        assert.ok(!hover.contents.value.includes(String.fromCharCode(code)));
      }
    }
  }
  for (const offset of [
    source.indexOf('Check "git.head-read"') + 8,
    source.indexOf('"hover-child@9.0.0"') + 2,
    source.indexOf("command:forged") + 2,
    source.lastIndexOf('"git.head-read@*"') + 2,
    source.indexOf('Operation "git.head-read"') + 12,
  ]) {
    assert.equal(
      await connection.sendRequest("textDocument/hover", {
        textDocument: { uri },
        position: positionAt(source, offset),
      }),
      null,
    );
  }
  // Document changes must not leave stale actionable links behind.
  const changed = waitForDiagnostics(connection, uri, 2);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [
      {
        text: '@trust-dsl:1 @procedure:hover-parent @version:1.0.0\nFeature: broken\n  Scenario: Broken\n    Then Invocation "bad" runs Procedure "hover-child\n',
      },
    ],
  });
  await changed;
  assert.deepEqual(await connection.sendRequest("textDocument/documentLink", { textDocument: { uri } }), []);
  await session.shutdown();
});

test("async catalog changes do not resurrect closed or older diagnostics and failures preserve the LSP connection", async (context) => {
  const session = await startLanguageServer(context, new URL("./support/catalog-server.js", import.meta.url).pathname);
  const { connection } = session;
  const uri = "file:///workspace/catalog/async.feature";
  const diagnostics: Array<{ uri: string; version: number; diagnostics: unknown[] }> = [];
  connection.onNotification("textDocument/publishDiagnostics", (value) => {
    diagnostics.push(value);
  });
  const text = "@trust-dsl:1 @procedure:async-catalog @version:1.0.0\nFeature: Catalog\n";
  await connection.sendRequest("acceptance/catalog", { action: "pause" });
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "gherkin", version: 1, text },
  });
  connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
  await connection.sendRequest("acceptance/catalog", { action: "release" });
  assert.deepEqual(
    diagnostics,
    [{ uri, version: 1, diagnostics: [] }],
    "closed documents must not receive deferred diagnostics",
  );
  diagnostics.length = 0;
  await connection.sendRequest("acceptance/catalog", { action: "pause" });
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "gherkin", version: 1, text },
  });
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: text + "  Scenario: Still incomplete\n" }],
  });
  await connection.sendRequest("acceptance/catalog", { action: "release" });
  assert.ok(diagnostics.length > 0);
  assert.ok(
    diagnostics.every((value) => value.version === 2),
    "only the latest open document version may publish",
  );
  diagnostics.length = 0;
  await connection.sendRequest("acceptance/catalog", { action: "fail" });
  const failed = waitForDiagnostics(connection, uri, 3);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [{ text }],
  });
  assert.equal((await failed).diagnostics[0]?.code, "catalog-unavailable");
  await assert.rejects(connection.sendRequest("textDocument/documentLink", { textDocument: { uri } }));
  assert.deepEqual(
    await connection.sendRequest("textDocument/documentLink", { textDocument: { uri: "file:///absent.feature" } }),
    [],
  );
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
  assert.deepEqual(await connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }), []);

  const docStringUri = "file:///workspace/docstring.feature";
  const docStringDiagnostics = waitForDiagnostics(connection, docStringUri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri: docStringUri,
      languageId: "gherkin",
      version: 1,
      text: 'Feature: Ordinary\n  Scenario: Text\n    Given a value\n      """\n      @operation:not-a-tag\n      """\n',
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
    "http.segments-query.feature",
  ];

  for (const [index, file] of files.entries()) {
    const uri = `file:///workspace/catalog/${file}`;
    const source = operationFixture(`valid/${file}`);
    const diagnostics = waitForDiagnostics(connection, uri, 1);
    connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "gherkin", version: 1, text: source },
    });
    assert.deepEqual(await diagnostics, { uri, version: 1, diagnostics: [] });

    const symbols = await connection.sendRequest<DocumentSymbol[]>("textDocument/documentSymbol", {
      textDocument: { uri },
    });
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
      assert.deepEqual(
        symbols[0]?.children?.map(({ name, detail }) => ({ name, detail })),
        [
          { name: "workspaceRoot", detail: "Environment: directory" },
          { name: "project", detail: "Input: reference one" },
          { name: "head", detail: "Step: shell" },
          { name: "status", detail: "Step: shell" },
          { name: "headRevision", detail: "Produced: reference one" },
          { name: "workingTree", detail: "Produced: string one" },
        ],
      );
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
        textDocument: { uri },
        position: stepsPosition,
      });
      assert.deepEqual(steps.map(({ label }) => label).sort(), ["head", "status"]);

      const resultPosition = positionAt(source, source.indexOf("steps.head.stdout") + "steps.head.".length);
      const shellResult = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
        textDocument: { uri },
        position: resultPosition,
      });
      assert.deepEqual(shellResult.map(({ label }) => label).sort(), ["exitCode", "stderr", "stdout"]);

      const jsonataPosition = positionAt(source, source.indexOf("$trim"));
      const jsonata = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
        textDocument: { uri },
        position: jsonataPosition,
      });
      assert.deepEqual(
        jsonata
          .map(({ label }) => label)
          .filter((label) => label.startsWith("$"))
          .sort(),
        operationLanguage.jsonata.functions.map((name) => `$${name}`).sort(),
      );

      const semantic = await connection.sendRequest<SemanticTokens>("textDocument/semanticTokens/full", {
        textDocument: { uri },
      });
      assertSemanticTokenAt(semantic, positionAt(source, 0), "# language: en".length, "comment");
      assertSemanticTokenAt(semantic, positionAt(source, source.indexOf("@trust-dsl:1")), "@trust-dsl:1".length, "tag");
      assertSemanticTokenAt(
        semantic,
        positionAt(source, source.indexOf("Feature")),
        "Feature".length,
        "keyword-control",
      );
      assertSemanticTokenAt(
        semantic,
        positionAt(source, source.indexOf("Feature:") + "Feature:".length),
        " Read Git HEAD and working tree".length,
        "title",
      );
      assertSemanticTokenAt(semantic, positionAt(source, source.indexOf("Given")), "Given".length, "keyword");
      assertSemanticTokenAt(
        semantic,
        positionAt(source, source.indexOf("Environment", source.indexOf("Given"))),
        "Environment".length,
        "type",
      );
      assertSemanticTokenAt(semantic, positionAt(source, source.indexOf("runs")), "runs".length, "verb");
      assertSemanticTokenAt(semantic, positionAt(source, source.indexOf('"head"')), '"head"'.length, "string");
      assertSemanticTokenAt(
        semantic,
        positionAt(source, source.indexOf("name", source.indexOf("| name"))),
        "name".length,
        "table-header",
      );
      assertSemanticTokenAt(
        semantic,
        positionAt(source, source.indexOf("workspaceRoot", source.indexOf("| workspaceRoot"))),
        "workspaceRoot".length,
        "table-cell",
      );
      assertSemanticTokenAt(semantic, positionAt(source, source.indexOf("{", source.indexOf('"""'))), 1, "delimiter");
      assertSemanticTokenAt(semantic, positionAt(source, source.indexOf("$trim")), "$trim".length, "function");
      assertSemanticTokenAt(semantic, positionAt(source, source.indexOf("steps.head")), "steps".length, "root");
      assertSemanticTokenAt(semantic, positionAt(source, source.indexOf("head.stdout")), "head".length, "property");
      assertSemanticTokenAt(semantic, positionAt(source, source.indexOf(' = "') + 1), 1, "operator");
    }
    if (file === "file.package-read.feature") {
      const afterFormat = source.indexOf("JSON from Environment") + "JSON ".length;
      const completions = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
        textDocument: { uri },
        position: positionAt(source, afterFormat),
      });
      assert.ok(completions.some(({ label }) => label === "from Environment"));
    }
    if (file === "http.status-read.feature") {
      const afterEnvironment = source.indexOf('"serviceUrl" and reads') + '"serviceUrl" '.length;
      const completions = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
        textDocument: { uri },
        position: positionAt(source, afterEnvironment),
      });
      assert.deepEqual(completions.map(({ label }) => label).sort(), [
        "and reads",
        "appending",
        "with Input as JSON body",
        "with JSONata body",
        "with Text body",
        "with header",
        "with query",
      ]);
    }
    if (file === "http.segments-query.feature") {
      const afterQueryName = source.indexOf('"limit" as') + '"limit" '.length;
      const completions = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
        textDocument: { uri },
        position: positionAt(source, afterQueryName),
      });
      assert.deepEqual(completions.map(({ label }) => label).sort(), ["as", "from Environment", "from Input"]);
    }
  }
}

async function assertNumericSemanticToken(connection: MessageConnection): Promise<void> {
  const uri = "file:///workspace/semantic/http.status-read.feature";
  const source = operationFixture("valid/http.status-read.feature").replace("steps.response.status", "1");
  const diagnostics = waitForDiagnostics(connection, uri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "trust-operation", version: 1, text: source },
  });
  assert.deepEqual(await diagnostics, { uri, version: 1, diagnostics: [] });
  const tokens = await connection.sendRequest<SemanticTokens>("textDocument/semanticTokens/full", {
    textDocument: { uri },
  });
  assertSemanticTokenAt(tokens, positionAt(source, source.lastIndexOf("1")), 1, "number");
}

async function assertOperationCompletionCompiles(connection: MessageConnection): Promise<void> {
  const uri = "file:///workspace/completion/file.package-read.feature";
  const source = operationFixture("valid/file.package-read.feature");
  const phrase = "from Environment";
  const insertionOffset = source.indexOf(phrase);
  assert.ok(insertionOffset > 0);
  const incomplete = source.slice(0, insertionOffset) + source.slice(insertionOffset + phrase.length);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "trust-operation", version: 1, text: incomplete },
  });
  const completions = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri },
    position: positionAt(incomplete, insertionOffset),
  });
  const completion = completions.find(({ label }) => label === phrase);
  assert.ok(completion);
  const completed =
    incomplete.slice(0, insertionOffset) +
    (completion.insertText ?? completion.label) +
    incomplete.slice(insertionOffset);
  compileOperation({ source: completed });
}

async function assertDefaultTemplates(connection: MessageConnection): Promise<void> {
  const operationUri = "file:///workspace/new-operation.feature";
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: operationUri, languageId: "trust-operation", version: 1, text: "" },
  });
  const operationItems = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: operationUri },
    position: { line: 0, character: 0 },
  });
  const operationTemplate = operationItems.find(({ label }) => label === "Operation feature")?.insertText;
  assert.ok(operationTemplate);
  compileOperation({ source: operationTemplate });

  const procedureUri = "file:///workspace/new-procedure.feature";
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: procedureUri, languageId: "trust-procedure", version: 1, text: "" },
  });
  const procedureItems = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: procedureUri },
    position: { line: 0, character: 0 },
  });
  const procedureTemplate = procedureItems.find(({ label }) => label === "Procedure feature")?.insertText;
  assert.ok(procedureTemplate);
  compileProcedure({
    source: procedureTemplate,
    operations: [compileOperation({ source: operationFixture("valid/git.head-read.feature") })],
  });

  const operationReference = '"git.head-read@^1.0.0"';
  const constraintOffset = procedureTemplate.indexOf(operationReference) + operationReference.length;
  const constraintUri = "file:///workspace/completion/new-procedure-constraint.feature";
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: constraintUri, languageId: "trust-procedure", version: 1, text: procedureTemplate },
  });
  const constraintItems = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: constraintUri },
    position: positionAt(procedureTemplate, constraintOffset),
  });
  assert.equal(constraintItems.find(({ label }) => label === "within")?.insertText, `within "\${1:10m}"`);
  assert.equal(
    constraintItems.find(({ label }) => label === "until")?.insertText,
    `until "\${1:2099-12-31T23:59:59Z}"`,
  );

  const incompleteDuration = `${procedureTemplate.slice(0, constraintOffset)} within "${procedureTemplate.slice(constraintOffset)}`;
  const durationUri = "file:///workspace/completion/new-procedure-duration.feature";
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: durationUri, languageId: "trust-procedure", version: 1, text: incompleteDuration },
  });
  const durationItems = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: durationUri },
    position: positionAt(incompleteDuration, constraintOffset + ' within "'.length),
  });
  assert.deepEqual(
    durationItems.map(({ label }) => label),
    ["500ms", "30s", "10m", "1h"],
  );
  const constrainedProcedure = `${procedureTemplate.slice(0, constraintOffset)} within "10m"${procedureTemplate.slice(constraintOffset)}`;
  compileProcedure({
    source: constrainedProcedure,
    operations: [compileOperation({ source: operationFixture("valid/git.head-read.feature") })],
  });
  const formattingUri = "file:///workspace/format/new-procedure-constraint.feature";
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: formattingUri, languageId: "trust-procedure", version: 1, text: constrainedProcedure },
  });
  const formattingEdits = await connection.sendRequest<Array<{ newText: string }>>("textDocument/formatting", {
    textDocument: { uri: formattingUri },
    options: { tabSize: 2, insertSpaces: true },
  });
  assert.ok(formattingEdits.length <= 1);
  const formattedConstraint = formattingEdits[0]?.newText ?? constrainedProcedure;
  assert.match(formattedConstraint, /Operation "git\.head-read@\^1\.0\.0" within "10m"/);
  compileProcedure({
    source: formattedConstraint,
    operations: [compileOperation({ source: operationFixture("valid/git.head-read.feature") })],
  });

  const scopeBlock = `Procedure scope
      | check | authorized | forbidden |
      | all   | Change repository files required by this Procedure. | Alter the environment to make a Check pass. |`;
  const incompleteScope = procedureTemplate.replace(scopeBlock, "");
  const scopeOffset = incompleteScope.indexOf("    Given ") + "    Given ".length;
  const scopeUri = "file:///workspace/completion/new-procedure-scope.feature";
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: scopeUri, languageId: "trust-procedure", version: 1, text: incompleteScope },
  });
  const scopeItems = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: scopeUri },
    position: positionAt(incompleteScope, scopeOffset),
  });
  const scopeCompletion = scopeItems.find(({ label }) => label === "Procedure scope");
  assert.ok(scopeCompletion?.insertText);
  assert.match(scopeCompletion.insertText, /\| check \| authorized \| forbidden \|/);
  const completedScope =
    incompleteScope.slice(0, scopeOffset) +
    scopeCompletion.insertText
      .replace("${1:Authorized actions.}", "Read the declared repository.")
      .replace("${2:Forbidden actions.}", "Alter the environment to make the Check pass.") +
    incompleteScope.slice(scopeOffset);
  compileProcedure({
    source: completedScope,
    operations: [compileOperation({ source: operationFixture("valid/git.head-read.feature") })],
  });

  const phrase = "must establish";
  const insertionOffset = procedureTemplate.indexOf(phrase);
  assert.ok(insertionOffset > 0);
  const incomplete =
    procedureTemplate.slice(0, insertionOffset) + procedureTemplate.slice(insertionOffset + phrase.length);
  const completionUri = "file:///workspace/completion/new-procedure.feature";
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: completionUri, languageId: "trust-procedure", version: 1, text: incomplete },
  });
  const grammarItems = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: completionUri },
    position: positionAt(incomplete, insertionOffset),
  });
  const grammarCompletion = grammarItems.find(({ label }) => label === phrase);
  assert.ok(grammarCompletion);
  const completed =
    incomplete.slice(0, insertionOffset) +
    (grammarCompletion.insertText ?? grammarCompletion.label) +
    incomplete.slice(insertionOffset);
  compileProcedure({
    source: completed,
    operations: [compileOperation({ source: operationFixture("valid/git.head-read.feature") })],
  });
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
    const symbols = await connection.sendRequest<DocumentSymbol[]>("textDocument/documentSymbol", {
      textDocument: { uri },
    });
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
    diagnostics: [
      {
        severity: 1,
        range: {
          start: { line: 14, character: 4 },
          end: { line: 14, character: 79 },
        },
        message: 'HTTP "response" uses undeclared Environment "missingUrl"',
        code: "unknown-environment",
        source: "trust-operation",
      },
    ],
  });
  const symbolsWhileInvalid = await connection.sendRequest<DocumentSymbol[]>("textDocument/documentSymbol", {
    textDocument: { uri },
  });
  assert.equal(symbolsWhileInvalid[0]?.name, "http.status-read");
  assert.deepEqual(
    symbolsWhileInvalid[0]?.children?.map(({ name }) => name),
    ["serviceUrl", "response", "service", "status"],
  );

  const corrected = waitForDiagnostics(connection, uri, 3);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [
      {
        range: { start, end },
        text: "serviceUrl",
      },
    ],
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
  assert.deepEqual(
    (await missingIdentity).diagnostics.map(({ code, message }) => ({ code, message })),
    [
      {
        code: "invalid-operation",
        message: "Operation must declare exactly one Operation tag",
      },
    ],
  );

  const identityRestored = waitForDiagnostics(connection, uri, 5);
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 5 },
    contentChanges: [
      {
        range: { start: operationTagStart, end: operationTagStart },
        text: operationTag,
      },
    ],
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
  assert.deepEqual(await connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }), []);
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
  const completionDiagnostics = waitForDiagnostics(
    connection,
    completionUri,
    1,
    (message) => message.diagnostics.length > 0,
  );
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: completionUri, languageId: "trust-procedure", version: 1, text: completionSource },
  });
  await completionDiagnostics;
  const declarationPrefix = 'one reference "repository" declared ';
  const declarationOffset = completionSource.indexOf(declarationPrefix) + declarationPrefix.length;
  const optionalCompletions = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: completionUri },
    position: positionAt(completionSource, declarationOffset),
  });
  const optionalCompletion = optionalCompletions.find(
    ({ label, kind }) => label === "optionally" && kind === CompletionItemKind.Keyword,
  );
  assert.ok(optionalCompletion);
  const completionOffset = declarationOffset;
  const completedSource =
    completionSource.slice(0, completionOffset) +
    (optionalCompletion.insertText ?? optionalCompletion.label) +
    completionSource.slice(completionOffset);
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
  const optionalizedSource =
    requiredSource.slice(0, beforeByAgent) +
    (existingClauseCompletion.insertText ?? existingClauseCompletion.label) +
    requiredSource.slice(beforeByAgent);
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
  assertSemanticTokenAt(
    optionalSemantic,
    positionAt(optionalSource, optionalSource.indexOf("declared optionally by agent")),
    "declared optionally by agent".length,
    "declaration",
  );

  const operationPosition = positionAt(source, source.indexOf('Operation "') + 'Operation "'.length);
  const operations = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri },
    position: operationPosition,
  });
  assert.ok(operations.some(({ label }) => label === "git.head-read@1.0.0"));

  const factPosition = positionAt(source, source.indexOf("fact.") + "fact.".length);
  const facts = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri },
    position: factPosition,
  });
  assert.deepEqual(facts.map(({ label }) => label).sort(), ["headRevision", "workingTree"]);

  const roots = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri },
    position: positionAt(source, source.indexOf("fact.")),
  });
  assert.ok(roots.some(({ label }) => label === "fail"));
  assert.ok(!roots.some(({ label }) => label === "failed"));

  const folds = await connection.sendRequest<FoldingRange[]>("textDocument/foldingRange", {
    textDocument: { uri },
  });
  const scenarioLine = positionAt(source, source.indexOf("Scenario:")).line;
  const qualificationLine = positionAt(source, source.lastIndexOf('"""')).line;
  assert.ok(
    folds.some(({ startLine, endLine }) => startLine === scenarioLine && endLine === qualificationLine),
    JSON.stringify({ folds, scenarioLine, qualificationLine }),
  );

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
    contentChanges: [
      { range: { start, end: positionAt(source, occurrence + "missingField".length) }, text: "workingTree" },
    ],
  });
  assert.deepEqual(await restored, { uri, version: 3, diagnostics: [] });

  const naturalUri = "file:///workspace/procedures/natural-role.feature";
  const naturalSource = source
    .replace(
      'Given one reference "repository"',
      'Given one reference "repository"\n    And one reference "baseline revision"',
    )
    .replace('fail("the repository has no local changes")', 'fail(`No changes since ${context["baseline revision"]}`)');
  const naturalDiagnostics = waitForDiagnostics(connection, naturalUri, 1);
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: naturalUri, languageId: "trust-procedure", version: 1, text: naturalSource },
  });
  assert.deepEqual(await naturalDiagnostics, { uri: naturalUri, version: 1, diagnostics: [] });
  const contextEnd = naturalSource.indexOf("context[") + "context".length;
  const roles = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: naturalUri },
    position: positionAt(naturalSource, contextEnd),
  });
  assert.deepEqual(roles.find(({ label }) => label === "baseline revision")?.textEdit, {
    range: { start: positionAt(naturalSource, contextEnd), end: positionAt(naturalSource, contextEnd) },
    newText: '["baseline revision"]',
  });

  const incompleteUri = "file:///workspace/procedures/incomplete-natural-role.feature";
  const completeAccessor = 'context["baseline revision"]';
  const incompleteAccessor = 'context["base';
  const incompleteSource = naturalSource.replace(completeAccessor, incompleteAccessor);
  const incompleteDiagnostics = waitForDiagnostics(
    connection,
    incompleteUri,
    1,
    (message) => message.diagnostics.length > 0,
  );
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: incompleteUri, languageId: "trust-procedure", version: 1, text: incompleteSource },
  });
  await incompleteDiagnostics;
  const incompleteEnd = incompleteSource.indexOf(incompleteAccessor) + incompleteAccessor.length;
  const incompleteRoles = await connection.sendRequest<CompletionItem[]>("textDocument/completion", {
    textDocument: { uri: incompleteUri },
    position: positionAt(incompleteSource, incompleteEnd),
  });
  assert.deepEqual(incompleteRoles.find(({ label }) => label === "baseline revision")?.textEdit, {
    range: {
      start: positionAt(incompleteSource, incompleteSource.indexOf(incompleteAccessor) + "context".length),
      end: positionAt(incompleteSource, incompleteEnd),
    },
    newText: '["baseline revision"]',
  });

  const multipleUri = "file:///workspace/procedures/multiple-errors.feature";
  const multipleSource =
    source.replace("fact.workingTree", "fact.missingOne").trimEnd() +
    `

    And Check "second status" runs Operation "git.head-read@*" on "repository" as Input "project" and must establish "the second observation is valid"
      """js
      fact.missingTwo === "dirty" ||
      fail("the second observation is invalid")
      """
`;
  const multipleDiagnostics = waitForDiagnostics(
    connection,
    multipleUri,
    1,
    (message) => message.diagnostics.length === 2,
  );
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: multipleUri, languageId: "trust-procedure", version: 1, text: multipleSource },
  });
  assert.deepEqual(
    (await multipleDiagnostics).diagnostics.map(({ code, message }) => ({ code, message })),
    [
      { code: "unknown-field", message: 'Operation "git.head-read" produces no field "missingOne"' },
      { code: "unknown-field", message: 'Operation "git.head-read" produces no field "missingTwo"' },
    ],
  );
}

async function startLanguageServer(
  context: TestContext,
  entry = new URL("../../bin/trust-language-server.js", import.meta.url).pathname,
): Promise<LanguageServerSession> {
  const server = spawn(process.execPath, [entry, "--stdio"], { stdio: "pipe" });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
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
    capabilities: {
      textDocumentSync?: unknown;
      documentSymbolProvider?: unknown;
      hoverProvider?: unknown;
      documentLinkProvider?: unknown;
      semanticTokensProvider?: { legend: { tokenTypes: string[]; tokenModifiers: string[] }; full: boolean };
    };
  }>("initialize", {
    processId: null,
    rootUri: null,
    capabilities: {
      textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
    },
  });
  assert.equal(initialized.capabilities.textDocumentSync, 2);
  assert.equal(initialized.capabilities.documentSymbolProvider, true);
  assert.equal(initialized.capabilities.hoverProvider, true);
  assert.deepEqual(initialized.capabilities.documentLinkProvider, { resolveProvider: false });
  assert.deepEqual(initialized.capabilities.semanticTokensProvider, {
    legend: { tokenTypes: [...semanticTokenTypes], tokenModifiers: [] },
    full: true,
  });
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
  return readFileSync(new URL(`../../../trust-operation/acceptance/fixtures/${path}`, import.meta.url), "utf8");
}

function procedureFixture(path: string): string {
  return readFileSync(new URL(`../../../../assets/procedures/${path}`, import.meta.url), "utf8");
}

function positionAt(source: string, offset: number): Position {
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function assertSemanticTokenAt(
  tokens: SemanticTokens,
  expected: Position,
  length: number,
  expectedType: (typeof semanticTokenTypes)[number],
): void {
  let line = 0;
  let character = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    const lineDelta = tokens.data[index] ?? 0;
    line += lineDelta;
    character = lineDelta === 0 ? character + (tokens.data[index + 1] ?? 0) : (tokens.data[index + 1] ?? 0);
    if (line === expected.line && character === expected.character && tokens.data[index + 2] === length) {
      assert.equal(tokens.data[index + 3], semanticTokenTypes.indexOf(expectedType), `${expectedType} semantic token`);
      return;
    }
  }
  assert.fail(`No semantic token at ${expected.line}:${expected.character}`);
}

function assertValidRange(range: Range | undefined, file: string): void {
  assert.ok(range, file);
  assert.ok(range.start.line >= 0, file);
  assert.ok(range.start.character >= 0, file);
  assert.ok(range.end.line > range.start.line || range.end.character > range.start.character, file);
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
    (message: PublishDiagnostics) => message.uri === uri && message.version === version && predicate(message),
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

interface CompletionItem {
  readonly label: string;
  readonly kind?: number;
  readonly insertText?: string;
  readonly textEdit?: { readonly range: Range; readonly newText: string };
}
interface FoldingRange {
  readonly startLine: number;
  readonly endLine: number;
}
interface SemanticTokens {
  readonly data: readonly number[];
}

interface LanguageServerSession {
  readonly connection: MessageConnection;
  readonly server: ChildProcessWithoutNullStreams;
  readonly shutdown: () => Promise<void>;
}
