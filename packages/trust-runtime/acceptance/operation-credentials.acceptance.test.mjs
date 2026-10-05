import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { operationCredentialNames, operationCredentialReferences } from "@trust/operation";
import { matchOperationCredentialReference } from "@trust/operation/match";

import { startPublicRuntime } from "../dist/acceptance/support/runtime-process.js";

let runtime;
before(async () => {
  runtime = await startPublicRuntime("trust-operation-credentials-");
});
after(async () => {
  await runtime?.close();
});

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

async function rpc(method, params) {
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function mcpTool(name, args) {
  const response = await fetch(`${runtime.endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.error, undefined, JSON.stringify(envelope));
  return envelope.result;
}

async function refused(source, sourceName) {
  const envelope = await rpc("operation.compile", { source, sourceName });
  assert.equal(envelope.result, undefined, JSON.stringify(envelope.result));
  assert.equal(envelope.error.data.contract, "trust.operation-compilation-error@1");
  return envelope.error.data;
}

test("SEC-030 AC1 a reference to an undeclared credential is refused at compilation", async () => {
  for (const [name, source, reference, line] of [
    ["header", operation({ header: "missingToken" }), 'HTTP "call" header "authorization"', 21],
    ["database", operation({ database: "missingToken" }), 'PostgreSQL "query" authentication', 23],
    ["variable", operation({ variable: "missingToken" }), 'Shell "deploy" variable "DEPLOY_TOKEN"', 28],
  ]) {
    const failure = await refused(source, `undeclared-${name}.feature`);
    assert.equal(failure.reason, "unknown-credential");
    assert.equal(failure.message, `${reference} references undeclared Credential "missingToken"`);
    assert.equal(failure.sourceName, `undeclared-${name}.feature`);
    assert.equal(failure.location?.line, line, `${name} refusal points at its step`);
  }

  const withoutDeclaration = operation().replace(/ {4}And Credentials\n(?: {6}\|[^\n]*\n)+/, "");
  assert.ok(!withoutDeclaration.includes("And Credentials"), "the declaration table is removed");
  assert.equal((await refused(withoutDeclaration, "no-declaration.feature")).reason, "unknown-credential");

  const unused = operation().replace("      | deployToken |\n", "      | deployToken |\n      | spareToken  |\n");
  const unusedFailure = await refused(unused, "unused.feature");
  assert.equal(unusedFailure.message, 'Credential "spareToken" is declared but no step references it');

  const repeated = operation().replace("      | deployToken |\n", "      | deployToken |\n      | apiToken    |\n");
  assert.equal((await refused(repeated, "repeated.feature")).reason, "duplicate-credential");

  const literal = operation().replace(
    'with header "Authorization" from Credential "apiToken"',
    'with header "Authorization" as "Bearer abcdefgh12345678" with header "X-Key" from Credential "apiToken"',
  );
  assert.equal((await refused(literal, "literal-secret.feature")).reason, "secret-like-value");
});

test("SEC-020 AC2 an Operation whose Produce reads a credential is refused at compilation", async () => {
  for (const produce of ['"status": $length(credentials.apiToken)', '"status": credentials.apiToken ? 1 : 0']) {
    const failure = await refused(operation({ produce }), "produce-reads-credential.feature");
    assert.equal(failure.reason, "credential-projection");
    assert.equal(
      failure.message,
      "Produce cannot read Credentials; a Credential reaches only the steps that reference it",
    );
  }

  const bodyReads = operation().replace(
    "and reads JSON",
    'with JSONata body and reads JSON\n      """\n      { "token": credentials.apiToken }\n      """',
  );
  const bodyFailure = await refused(bodyReads, "body-reads-credential.feature");
  assert.equal(bodyFailure.reason, "credential-projection");
  assert.match(bodyFailure.message, /^HTTP "call" JSONata body cannot read Credentials/);

  const query = operation().replace(
    'with header "Authorization" from Credential "apiToken"',
    'with query "token" from Credential "apiToken"',
  );
  assert.equal((await refused(query, "query-credential.feature")).reason, "unknown-step");
});

test("SEC-060 AC1 credential declarations and HTTP, PostgreSQL and Shell references compile to canonical Operation definitions", async () => {
  const source = operation();
  const envelope = await rpc("operation.compile", { source, sourceName: "secret.read.feature" });
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  const compiled = envelope.result;
  assert.equal(compiled.contract, "trust.compiled-operation@1");
  assert.deepEqual(compiled.credentials, ["apiToken", "dbPassword", "deployToken"]);
  assert.deepEqual(operationCredentialNames(compiled), ["apiToken", "dbPassword", "deployToken"]);

  const [http, postgresql, shell] = compiled.steps;
  assert.deepEqual(http.http.headers, [
    { name: "authorization", source: { kind: "credential", credential: "apiToken" } },
  ]);
  assert.deepEqual(postgresql.postgresql, {
    connection: { environment: "databaseUrl" },
    statement: "SELECT 1 AS result",
    authentication: { kind: "credential", credential: "dbPassword" },
  });
  assert.deepEqual(shell.shell.variables, [
    { name: "DEPLOY_TOKEN", source: { kind: "credential", credential: "deployToken" } },
  ]);
  assert.deepEqual(compiled.environment.required, ["serviceUrl", "databaseUrl", "root"]);
  assert.equal(JSON.stringify(compiled.environment).includes("Token"), false, "Credentials are not Environment values");

  const described = operationCredentialReferences(compiled).map((reference) =>
    matchOperationCredentialReference(reference, {
      "http-header": ({ step, header, credential }) => `${step}: header ${header} <- ${credential}`,
      "postgresql-authentication": ({ step, credential }) => `${step}: password <- ${credential}`,
      "shell-variable": ({ step, variable, credential }) => `${step}: ${variable} <- ${credential}`,
    }),
  );
  assert.deepEqual(described, [
    "call: header authorization <- apiToken",
    "query: password <- dbPassword",
    "deploy: DEPLOY_TOKEN <- deployToken",
  ]);

  const withoutCredentials = (
    await rpc("operation.compile", {
      source: source
        .replace(/ {4}And Credentials\n(?: {6}\|[^\n]*\n)+/, "")
        .replace(' from Credential "apiToken"', ' as "public"')
        .replace('\n        authenticated by Credential "dbPassword"', "")
        .replace('\n        with variable "DEPLOY_TOKEN" from Credential "deployToken"', ""),
      sourceName: "no-credentials.feature",
    })
  ).result;
  assert.ok(withoutCredentials, "an Operation without Credentials still compiles");
  assert.equal("credentials" in withoutCredentials, false);
  assert.equal("authentication" in withoutCredentials.steps[1].postgresql, false);
  assert.equal("variables" in withoutCredentials.steps[2].shell, false);

  const mcp = await mcpTool("trust_operation_compile", { source, sourceName: "secret.read.feature" });
  assert.notEqual(mcp.isError, true);
  const text = mcp.content.map((part) => part.text).join("\n");
  assert.match(text, /^Credentials: apiToken, dbPassword, deployToken$/m);
});

test("SEC-060 AC3 the packaged grammar reference documents credential declarations and references", async () => {
  const read = async (document) => {
    let text = "";
    let cursor;
    let pages = 0;
    do {
      const result = await mcpTool("trust_documentation_read", {
        document,
        limit: 12000,
        ...(cursor ? { cursor } : {}),
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const page = result.content.map((part) => part.text).join("\n");
      text += page.split("\nCONTENT\n")[1] ?? "";
      cursor = page.match(/^Next cursor: (.+)$/m)?.[1];
      assert.ok(++pages < 20, "pagination terminates");
    } while (cursor);
    return text;
  };
  const grammar = await read("references/operation-grammar");
  assert.match(grammar, /^## Credentials$/m);
  assert.match(grammar, /And Credentials\n\s+\| name\s+\|/);
  for (const reference of [
    'with header "Authorization" from Credential "apiToken"',
    'authenticated by Credential "dbPassword"',
    'with variable "DEPLOY_TOKEN" from Credential "deployToken"',
  ]) {
    assert.ok(grammar.includes(reference), `the grammar documents ${reference}`);
  }
  assert.match(grammar, /refuses a reference to an undeclared Credential/);
  assert.match(grammar, /cannot\s+read Credentials/);

  const procedureGrammar = await read("references/procedure-grammar");
  assert.match(procedureGrammar, /^## Operation Credentials$/m);
  assert.match(procedureGrammar, /trust-doc:\/\/\/references\/operation-grammar#credentials/);

  let catalog = "";
  let cursor;
  let pages = 0;
  do {
    const listed = await mcpTool("trust_documentation_list", {
      ...(cursor ? { cursor } : { query: "Credential" }),
      limit: 25,
    });
    assert.notEqual(listed.isError, true, JSON.stringify(listed));
    const page = listed.content.map((part) => part.text).join("\n");
    catalog += page;
    cursor = page.match(/^Next cursor: (.+)$/m)?.[1];
    assert.ok(++pages < 20, "listing pagination terminates");
  } while (cursor);
  assert.match(catalog, /^- references\/operation-grammar: TRUST Operation catalog$/m);
});
