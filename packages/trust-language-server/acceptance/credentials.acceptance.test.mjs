import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import jsonrpc from "vscode-jsonrpc/node";

const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = jsonrpc;
const entry = fileURLToPath(new URL("../bin/trust-language-server.js", import.meta.url));
const declared = ["apiToken", "dbPassword", "deployToken"];

const operation = ({
  header = "apiToken",
  database = "dbPassword",
  variable = "deployToken",
  produce = '"status": steps.call.status',
} = {}) => `# language: en
@trust-dsl:1 @operation:secret.read @version:1.0.0
Feature: Call services with Environment Credentials

  Background: Operation interface
    Given Environment
      | name        | type      |
      | serviceUrl  | url       |
      | databaseUrl | string    |
      | root        | directory |
    And Credentials
      | name        |
      | apiToken    |
      | dbPassword  |
      | deployToken |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "call" sends "GET" to Environment "serviceUrl"
        with header "Authorization" from Credential "${header}" and reads JSON
    And PostgreSQL "query" executes SQL on Environment "databaseUrl"
        authenticated by Credential "${database}" with Input as JSONB parameter $1
      """
      SELECT 1 AS result
      """
    And Shell "deploy" runs "deploy" with cwd from Environment "root"
        with variable "DEPLOY_TOKEN" from Credential "${variable}"
      | argument |
      | now      |
    Then Produce with JSONata
      """
      { ${produce} }
      """
`;

test("SEC-060 AC2 the language server completes declared credential names and reports undeclared references", async (t) => {
  const session = await startLanguageServer(t);
  const { connection } = session;
  let version = 0;
  const open = async (uri, text) => {
    version += 1;
    const diagnostics = waitForDiagnostics(connection, uri, version);
    connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "gherkin", version, text },
    });
    return (await diagnostics).diagnostics;
  };

  const validUri = "file:///workspace/credentials/secret.read.feature";
  const valid = operation();
  assert.deepEqual(await open(validUri, valid), []);

  const complete = async (uri, source, offset) =>
    (
      await connection.sendRequest("textDocument/completion", {
        textDocument: { uri },
        position: positionAt(source, offset),
      })
    ).map(({ label }) => label);

  for (const reference of [
    'from Credential "apiToken"',
    'authenticated by Credential "dbPassword"',
    'from Credential "deployToken"',
  ]) {
    const offset = valid.indexOf(reference) + reference.indexOf('"') + 1;
    assert.deepEqual(await complete(validUri, valid, offset), declared, `completion inside ${reference}`);
  }

  const headerClause = 'with header "Authorization" ';
  const afterHeader = await complete(validUri, valid, valid.indexOf(headerClause) + headerClause.length);
  assert.ok(afterHeader.includes("from Credential"), `header sources: ${afterHeader.join(", ")}`);
  const afterDatabase = 'on Environment "databaseUrl"\n        ';
  const databaseOptions = await complete(validUri, valid, valid.indexOf(afterDatabase) + afterDatabase.length);
  assert.ok(
    databaseOptions.includes("authenticated by Credential"),
    `PostgreSQL clauses: ${databaseOptions.join(", ")}`,
  );

  const interfaceLine = valid.indexOf("    And Produced fields");
  const blockOptions = await complete(validUri, valid, interfaceLine);
  assert.ok(blockOptions.includes("Credentials interface"), `interface snippets: ${blockOptions.join(", ")}`);

  const symbols = await connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri: validUri } });
  assert.deepEqual(
    symbols[0].children.filter(({ detail }) => detail === "Credential").map(({ name }) => name),
    declared,
  );

  for (const [name, source, reference] of [
    ["header", operation({ header: "missingToken" }), 'HTTP "call" header "authorization"'],
    ["database", operation({ database: "missingToken" }), 'PostgreSQL "query" authentication'],
    ["variable", operation({ variable: "missingToken" }), 'Shell "deploy" variable "DEPLOY_TOKEN"'],
  ]) {
    const diagnostics = await open(`file:///workspace/credentials/undeclared-${name}.feature`, source);
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
    const [diagnostic] = diagnostics;
    assert.equal(diagnostic.code, "unknown-credential");
    assert.equal(diagnostic.message, `${reference} references undeclared Credential "missingToken"`);
    const stepLine = source.split("\n").findIndex((line) => line.includes(reference.split(" ").slice(0, 2).join(" ")));
    assert.equal(diagnostic.range.start.line, stepLine, `${name} diagnostic points at its step`);
  }

  const projection = await open(
    "file:///workspace/credentials/produce-reads-credential.feature",
    operation({ produce: '"status": $length(credentials.apiToken)' }),
  );
  assert.deepEqual(
    projection.map(({ code }) => code),
    ["credential-projection"],
  );

  await session.shutdown();
});

async function startLanguageServer(t) {
  const server = spawn(process.execPath, [entry, "--stdio"], { stdio: "pipe" });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (server.exitCode === null) server.kill("SIGTERM");
  });
  const connection = createMessageConnection(
    new StreamMessageReader(server.stdout),
    new StreamMessageWriter(server.stdin),
  );
  connection.listen();
  t.after(() => connection.dispose());
  await connection.sendRequest("initialize", {
    processId: null,
    rootUri: null,
    capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
  });
  connection.sendNotification("initialized", {});
  return {
    connection,
    shutdown: async () => {
      await connection.sendRequest("shutdown");
      connection.sendNotification("exit");
      await once(server, "exit");
      assert.equal(server.exitCode, 0, stderr);
    },
  };
}

function positionAt(source, offset) {
  const lines = source.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function waitForDiagnostics(connection, uri, version) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for diagnostics of ${uri}`));
    }, 5_000);
    const subscription = connection.onNotification("textDocument/publishDiagnostics", (message) => {
      if (message.uri !== uri || message.version !== version) return;
      clearTimeout(timeout);
      subscription.dispose();
      resolve(message);
    });
  });
}
