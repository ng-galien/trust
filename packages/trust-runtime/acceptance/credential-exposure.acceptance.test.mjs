import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startPublicRuntime } from "../dist/acceptance/support/runtime-process.js";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const environmentName = "exposure";
const plan = "credential-exposure";

const secret = (prefix) => `${prefix}-${randomBytes(18).toString("hex")}`;
const secrets = {
  apiToken: `Bearer ${secret("api")}`,
  shellToken: secret("shell"),
  unusedToken: secret("unused"),
};

let directory;
let runtime;
let service;
let runnerScript;

const operationInterface = (environment, credential, produced) => `  Background: Operation interface
    Given Environment
      | name | type |
      | ${environment[0]} | ${environment[1]} |
    And Credentials
      | name |
      | ${credential} |
    And Input
      | input   | type      | cardinality |
      | subject | reference | one         |
    And Produced fields
      | field | type | cardinality | domain |
${produced.map(([field, type]) => `      | ${field} | ${type} | one | any |`).join("\n")}
`;

const httpOperation = (name, environment) => `# language: en
@trust-dsl:1 @operation:${name} @version:1.0.0
Feature: Call a service with a header taken from a delegated Credential

${operationInterface([environment, "url"], "apiToken", [
  ["accepted", "string"],
  ["echoed", "string"],
])}
  Scenario: Run
    When HTTP "call" sends "GET" to Environment "${environment}"
        with header "Authorization" from Credential "apiToken" and reads JSON
    Then Produce with JSONata
      """
      { "accepted": steps.call.body.accepted, "echoed": steps.call.body.authorization }
      """
`;

const operationSources = {
  "exposure.http-accepted": httpOperation("exposure.http-accepted", "acceptedUrl"),
  "exposure.http-denied": httpOperation("exposure.http-denied", "deniedUrl"),
  "exposure.shell-leak": `# language: en
@trust-dsl:1 @operation:exposure.shell-leak @version:1.0.0
Feature: Fail after printing a delegated Credential

${operationInterface(["workspaceRoot", "directory"], "shellToken", [["exit", "number"]])}
  Scenario: Run
    When Shell "leak" runs "node" with cwd from Environment "workspaceRoot"
        with variable "LEAK_VALUE" from Credential "shellToken"
      | argument | source  |
      | leak.mjs | literal |
    Then Produce with JSONata
      """
      { "exit": steps.leak.exitCode }
      """
`,
};

const procedureSource = `# language: en
@trust-dsl:1 @procedure:credential-exposure @version:1.0.0
Feature: Use delegated Credentials in successful and failed attempts

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Run the acceptance Operation. | Read a secret the Operation does not declare. |
    Given one reference "subject"

  @scenario:accepted
  Scenario: Call the accepting service
    Then Check "http accepted" runs Operation "exposure.http-accepted@1.0.0" on "subject" as Input "subject" and must establish "the service accepted the header"
      """js
      fact.accepted === "yes" || fail("the service refused the header")
      """

  @scenario:denied
  Scenario: Call the denying service
    Then Check "http denied" runs Operation "exposure.http-denied@1.0.0" on "subject" as Input "subject" and must establish "the service accepted the header"
      """js
      fact.accepted === "yes" || fail("the service refused the header")
      """

  @scenario:leak
  Scenario: Fail after printing
    Then Check "shell leak" runs Operation "exposure.shell-leak@1.0.0" on "subject" as Input "subject" and must establish "the command succeeded"
      """js
      fact.exit === 0 || fail("the command failed")
      """
`;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "trust-credential-exposure-"));
  const workspace = path.join(directory, "workspace");
  const operations = path.join(directory, "operations");
  await Promise.all([mkdir(workspace), mkdir(operations)]);
  await writeFile(
    path.join(workspace, "leak.mjs"),
    `process.stdout.write("stdout " + process.env.LEAK_VALUE);
process.stderr.write("stderr " + process.env.LEAK_VALUE);
process.exit(3);
`,
  );
  for (const [name, source] of Object.entries(operationSources)) {
    await writeFile(path.join(operations, `${name}.feature`), source);
  }
  const skill = path.join(directory, "skill");
  await execute(
    process.execPath,
    [path.join(root, "packages/trust-runner/scripts/package-skill.ts"), "--output", skill],
    { cwd: root },
  );
  runnerScript = path.join(skill, "scripts/run.js");
  service = await startHttpService();
  runtime = await startPublicRuntime("trust-credential-exposure-", {
    operationsDirectory: operations,
    environments: {
      [environmentName]: {
        acceptedUrl: `${service.url}/accept`,
        deniedUrl: `${service.url}/deny`,
        workspaceRoot: workspace,
      },
    },
  });
  for (const [name, value] of Object.entries(secrets)) {
    await rpc("credential.save", { environment: environmentName, name, value });
  }
  await rpc("procedure.publish", { source: procedureSource, sourceName: "credential-exposure.feature" });
  await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "credential-exposure",
    procedureVersion: "1.0.0",
    plan,
    environment: environmentName,
    rootInputs: { subject: "acceptance" },
  });
});

after(async () => {
  await runtime?.close();
  await service?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("SEC-020 AC1 MCP and RPC projections never return a delegated credential after successful and failed attempts", async () => {
  const accepted = await runRunner("exposure.http-accepted");
  assert.equal(accepted.code, 0, accepted.stderr);
  const acceptedResult = JSON.parse(accepted.stdout).result;
  assert.equal(acceptedResult.qualification.verdict, "VALIDATED", accepted.stdout);

  const denied = await runRunner("exposure.http-denied");
  assert.equal(denied.code, 0, denied.stderr);
  const deniedResult = JSON.parse(denied.stdout).result;
  assert.equal(deniedResult.qualification.verdict, "NOT_VALIDATED", denied.stdout);

  const leak = await runRunner("exposure.shell-leak");
  assert.notEqual(leak.code, 0, "the leaking command fails the attempt");

  assert.deepEqual(
    service.authorizations,
    [secrets.apiToken, secrets.apiToken],
    "both HTTP attempts really used the delegated credential",
  );

  const checkUris = await Promise.all(Object.keys(operationSources).map((operation) => checkUri(operation)));
  const checks = await Promise.all(
    checkUris.map((uri) => rpc("check.read", { contract: "trust.check-read-request@1", checkUri: uri })),
  );
  const httpFacts = checks
    .slice(0, 2)
    .map((check) => check.attempts.flatMap((attempt) => attempt.facts ?? []).map((fact) => fact.values.echoed));
  assert.deepEqual(
    httpFacts,
    [["[credential apiToken]"], ["[credential apiToken]"]],
    "both HTTP attempts recorded Facts that echo the masked header",
  );
  assert.ok(checks[2].attempts.length > 0, "the failed Shell attempt is recorded");

  const rpcSurfaces = {
    "plan.read": await rpc("plan.read", { plan }),
    "plan.list": await rpc("plan.list", {}),
    "history.list": await rpc("history.list", { filter: { plan } }),
    "session.read": await rpc("session.read", { plan }),
    "check.read": checks,
    "environment.list": await rpc("environment.list", {}),
    "environment.list operation": await rpc("environment.list", {
      operation: "exposure.shell-leak",
      version: "1.0.0",
    }),
    "credential.list": await rpc("credential.list", { environment: environmentName }),
    "operation.environments": await rpc("operation.environments", {}),
  };
  const credentialNames = rpcSurfaces["credential.list"];
  assert.match(JSON.stringify(credentialNames), /apiToken/, "credential.list returns names");

  const tools = await mcp("tools/list", {});
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("trust_plan_read"));
  assert.deepEqual(
    toolNames.filter((name) => /credential|secret/i.test(name)),
    [],
    "MCP exposes no tool that reads credentials",
  );

  const mcpCalls = [
    ["trust_plan_read", { plan }],
    ["trust_session_read", { checkUri: checkUris[0] }],
    ["trust_procedure_read", { checkUri: checkUris[0] }],
    ...checkUris.map((uri) => ["trust_check_read", { checkUri: uri }]),
    ["trust_environment_list", {}],
    ["trust_operation_list", {}],
    ...Object.keys(operationSources).flatMap((operation) => [
      ["trust_operation_read", { operation, version: "1.0.0" }],
      ["trust_operation_environment_list", { operation, version: "1.0.0" }],
    ]),
    ["trust_operation_trial_list", {}],
    ["trust_procedure_list", {}],
    ["trust_published_procedure_read", { procedure: "credential-exposure", version: "1.0.0" }],
  ];
  const mcpSurfaces = {};
  for (const [name, args] of mcpCalls) {
    const result = await mcp("tools/call", { name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    mcpSurfaces[`${name} ${JSON.stringify(args)}`] = result;
  }
  assert.match(JSON.stringify(mcpSurfaces), /NOT_VALIDATED/, "MCP projections describe the failed qualification");

  const surfaces = { ...rpcSurfaces, ...mcpSurfaces };
  for (const [name, value] of Object.entries(secrets)) {
    for (const [surface, projection] of Object.entries(surfaces)) {
      assert.ok(!JSON.stringify(projection).includes(value), `Credential ${name} leaked into ${surface}`);
    }
  }
});

async function runRunner(operation) {
  const child = spawn(process.execPath, [runnerScript, await checkUri(operation), "--json"], {
    cwd: directory,
    env: {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: directory,
      LANG: "C",
      TMPDIR: tmpdir(),
      TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
      TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
      TRUST_RUNNER_LOG_PATH: path.join(directory, "runner.log"),
      TRUST_SERVER_STATE_DIRECTORY: path.join(directory, "runner-state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

async function checkUri(operation) {
  const view = await rpc("plan.read", { plan });
  const check = view.checks.find((value) => value.operation === operation);
  assert.ok(check, `Plan has no Check for ${operation}`);
  return check.checkUri;
}

async function rpc(method, params) {
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  const envelope = await response.json();
  assert.equal(envelope.error, undefined, `${method}: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}

async function mcp(method, params) {
  const response = await fetch(`${runtime.endpoint}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const envelope = await response.json();
  assert.equal(envelope.error, undefined, `${method}: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}

async function startHttpService() {
  const authorizations = [];
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    authorizations.push(authorization);
    const accepted = request.url === "/accept" && authorization === secrets.apiToken ? "yes" : "no";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted, authorization }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    authorizations,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
