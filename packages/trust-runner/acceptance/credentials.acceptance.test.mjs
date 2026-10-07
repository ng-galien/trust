import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// libpq ships initdb and pg_ctl without the server; the first directory that also holds postgres is used.
const postgresqlBin = [
  ...(process.env.TRUST_POSTGRESQL_BIN ? [process.env.TRUST_POSTGRESQL_BIN] : []),
  "/opt/homebrew/opt/libpq/bin",
  "/opt/homebrew/opt/postgresql@18/bin",
  "/opt/homebrew/opt/postgresql@17/bin",
  "/opt/homebrew/bin",
  // Debian and Ubuntu install each major version under /usr/lib/postgresql.
  "/usr/lib/postgresql/18/bin",
  "/usr/lib/postgresql/17/bin",
  "/usr/lib/postgresql/16/bin",
].find((candidate) => existsSync(path.join(candidate, "postgres")));
// macOS PostgreSQL refuses to start without a valid locale in its process environment.
const postgresqlProcessEnvironment = { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" };
const environmentName = "credential-acceptance";
const plan = "credential-delegation";
// macOS adds __CF_USER_TEXT_ENCODING to every spawned process; it does not come from the Runner.
const allowedProcessVariables = /^(PATH|HOME|LANG|TMPDIR|LC_.*|__CF_USER_TEXT_ENCODING)$/;

const secret = (prefix) => `${prefix}-${randomBytes(18).toString("hex")}`;
const secrets = {
  databasePassword: secret("pg"),
  apiToken: `Bearer ${secret("api")}`,
  shellToken: secret("shell"),
};
const runnerProcessSecret = secret("runner-process");
const wrongDatabasePassword = secret("wrong-pg");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

let directory;
let postgresql;
let runtime;
let service;
let otlp;
const otlpBodies = [];
const runnerOutputs = [];
const httpAuthorizations = [];
let runnerLog;
let runnerScript;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "trust-runner-credentials-"));
  runnerLog = path.join(directory, "runner.log");
  const workspace = path.join(directory, "workspace");
  const operations = path.join(directory, "operations");
  await Promise.all([mkdir(workspace), mkdir(operations)]);
  await writeFile(
    path.join(workspace, "probe.mjs"),
    `import { createHash } from "node:crypto";
const value = process.env.PROBE_VALUE;
process.stdout.write(JSON.stringify({
  probe: value === undefined ? null : createHash("sha256").update(value).digest("hex"),
  names: Object.keys(process.env).sort(),
}));
`,
  );
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

  const [skill] = await Promise.all([
    packageRunner(path.join(directory, "skill")),
    startPostgresql(path.join(directory, "postgresql")).then((value) => {
      postgresql = value;
    }),
  ]);
  runnerScript = path.join(skill, "scripts/run.js");
  service = await startHttpService();
  runtime = await startRuntime(operations);
  otlp = await startOtlpRecorder(`${runtime.endpoint}/v1/traces`);

  await rpc("environment.save", {
    environment: environmentName,
    values: {
      databaseUrl: `postgresql://delegate@127.0.0.1:${postgresql.port}/postgres`,
      serviceUrl: service.url,
      workspaceRoot: workspace,
    },
  });
  for (const [name, value] of Object.entries(secrets)) {
    await rpc("credential.save", { environment: environmentName, name, value });
  }
  await rpc("procedure.publish", { source: procedureSource, sourceName: "credential-delegation.feature" });
  await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "credential-delegation",
    procedureVersion: "1.0.0",
    plan,
    environment: environmentName,
    rootInputs: { subject: "acceptance" },
  });
});

after(async () => {
  await runtime?.close();
  await Promise.all([service?.close(), otlp?.close()]);
  await postgresql?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("SEC-010 AC1 a PostgreSQL step authenticates with an Environment credential without any Runner process variable", async () => {
  const output = await runCheck("credential.postgresql-identity");
  assert.equal(output.result.status, "COMPLETED", JSON.stringify(output));
  assert.equal(output.result.qualification.verdict, "VALIDATED", JSON.stringify(output));
  assert.deepEqual(output.result.actionOutcome.identity.result, { user: "delegate", subject: "acceptance" });
  const fact = await acceptedFact("credential.postgresql-identity");
  assert.deepEqual(fact.values, { user: "delegate" });
});

test("SEC-010 AC2 an HTTP header takes its value from an Environment credential", async () => {
  const output = await runCheck("credential.http-bearer");
  assert.equal(output.result.status, "COMPLETED", JSON.stringify(output));
  assert.equal(output.result.qualification.verdict, "VALIDATED", JSON.stringify(output));
  assert.deepEqual(httpAuthorizations, [secrets.apiToken], "the service received the delegated header value");
  const fact = await acceptedFact("credential.http-bearer");
  assert.deepEqual(fact.values, { accepted: "yes", echoed: "[credential apiToken]" });
  assert.equal(output.result.actionOutcome.call.body.authorization, "[credential apiToken]");
});

test("SEC-050 AC1 an undeclared secret variable of the Runner process is invisible to a Shell command", async () => {
  const output = await runCheck("credential.shell-probe");
  assert.equal(output.result.status, "COMPLETED", JSON.stringify(output));
  for (const step of ["declared", "other"]) {
    const probe = JSON.parse(output.result.actionOutcome[step].stdout);
    assert.ok(!probe.names.includes("RUNNER_PROCESS_SECRET"), `${step} must not see a Runner process secret`);
    assert.ok(!probe.names.includes("PGPASSWORD"), `${step} must not see a Runner database password`);
    assert.ok(!probe.names.some((name) => name.startsWith("TRUST_")), `${step} must not see Runner configuration`);
    const unexpected = probe.names.filter((name) => !allowedProcessVariables.test(name) && name !== "PROBE_VALUE");
    assert.deepEqual(unexpected, [], `${step} receives only the allowlist and its declared variables`);
    assert.ok(probe.names.includes("PATH") && probe.names.includes("HOME"));
  }
});

test("SEC-050 AC2 a Shell variable declared from a credential is visible to that command only", async () => {
  const fact = await acceptedFact("credential.shell-probe");
  const declared = JSON.parse(fact.values.declared);
  const other = JSON.parse(fact.values.other);
  assert.equal(declared.probe, sha256(secrets.shellToken), "the declaring step receives the Credential value");
  assert.ok(declared.names.includes("PROBE_VALUE"));
  assert.equal(other.probe, null, "a step that does not declare the variable does not receive it");
  assert.ok(!other.names.includes("PROBE_VALUE"));
});

test("SEC-020 AC1 a delegated credential never appears in Facts, actionOutcome, OTLP traces or Runner diagnostics", async () => {
  const failed = await runRunner(await checkUri("credential.shell-leak"));
  assert.notEqual(failed.code, 0, "the leaking command fails the attempt");
  assert.match(failed.stderr, /\[credential shellToken\]/, "the failure reason is kept with the value masked");
  const leak = (await readCheck("credential.shell-leak")).attempts.flatMap((attempt) => attempt.facts ?? []);
  assert.deepEqual(leak, [], "a failed attempt exports no Fact");

  const checks = await Promise.all(Object.keys(operationSources).map((operation) => readCheck(operation)));
  const view = await rpc("plan.read", { plan });
  const mcp = await mcpPlanRead();
  const log = await readFile(runnerLog, "utf8");
  assert.match(log, /\[credential shellToken\]/, "Runner diagnostics recorded the masked command output");
  assert.equal(
    otlpBodies.length,
    3,
    "each of the three completed attempts exported its Facts through the OTLP recorder",
  );
  const surfaces = {
    facts: JSON.stringify(checks),
    plan: JSON.stringify(view),
    mcp,
    actionOutcome: runnerOutputs.map((output) => output.stdout).join("\n"),
    runnerStderr: runnerOutputs.map((output) => output.stderr).join("\n"),
    runnerDiagnostics: log,
    otlp: Buffer.concat(otlpBodies).toString("latin1"),
  };
  for (const [name, value] of Object.entries(secrets)) {
    for (const [surface, text] of Object.entries(surfaces)) {
      assert.ok(!text.includes(value), `Credential ${name} leaked into ${surface}`);
    }
  }
  for (const [surface, text] of Object.entries(surfaces)) {
    assert.ok(!text.includes(runnerProcessSecret), `Runner process secret leaked into ${surface}`);
  }
});

async function runCheck(operation) {
  const execution = await runRunner(await checkUri(operation));
  assert.equal(execution.code, 0, execution.stderr);
  return JSON.parse(execution.stdout);
}

async function runRunner(uri) {
  const child = spawn(process.execPath, [runnerScript, uri, "--json"], {
    cwd: directory,
    env: {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: directory,
      LANG: "C",
      TMPDIR: tmpdir(),
      TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
      TRUST_OTLP_ENDPOINT: otlp.url,
      TRUST_RUNNER_LOG_PATH: runnerLog,
      TRUST_LOG_LEVEL: "debug",
      TRUST_SERVER_STATE_DIRECTORY: path.join(directory, "runner-state"),
      RUNNER_PROCESS_SECRET: runnerProcessSecret,
      PGPASSWORD: wrongDatabasePassword,
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
  const output = { code, stdout, stderr };
  runnerOutputs.push(output);
  return output;
}

async function checkUri(operation) {
  const view = await rpc("plan.read", { plan });
  const check = view.checks.find((value) => value.operation === operation);
  assert.ok(check, `Plan has no Check for ${operation}`);
  return check.checkUri;
}

async function readCheck(operation) {
  return rpc("check.read", { contract: "trust.check-read-request@1", checkUri: await checkUri(operation) });
}

async function acceptedFact(operation) {
  const observed = await readCheck(operation);
  const facts = observed.attempts.flatMap((attempt) => attempt.facts ?? []);
  assert.equal(facts.length, 1, JSON.stringify(observed));
  return facts[0];
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

async function mcpPlanRead() {
  const response = await fetch(`${runtime.endpoint}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "trust_plan_read", arguments: { plan } },
    }),
  });
  const envelope = await response.json();
  assert.ok(envelope.result && !envelope.result.isError, JSON.stringify(envelope));
  return JSON.stringify(envelope.result);
}

async function packageRunner(output) {
  await execute(
    process.execPath,
    [path.join(root, "packages/trust-runner/scripts/package-skill.ts"), "--output", output],
    { cwd: root },
  );
  return output;
}

async function startPostgresql(data) {
  const passwordFile = path.join(directory, "owner-password");
  const ownerPassword = secret("owner");
  await writeFile(passwordFile, ownerPassword);
  await execute(
    path.join(postgresqlBin, "initdb"),
    ["-D", data, "-U", "owner", "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "-E", "UTF8", "--locale=C"],
    { env: postgresqlProcessEnvironment },
  );
  const port = await freePort();
  const sockets = await mkdtemp(path.join(tmpdir(), "pg-"));
  await execute(
    path.join(postgresqlBin, "pg_ctl"),
    [
      "-D",
      data,
      "-l",
      path.join(directory, "postgresql.log"),
      "-o",
      `-p ${port} -c listen_addresses=127.0.0.1 -k ${sockets}`,
      "-w",
      "start",
    ],
    { env: postgresqlProcessEnvironment },
  );
  const stop = async () => {
    await execute(path.join(postgresqlBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], {
      env: postgresqlProcessEnvironment,
    }).catch(() => undefined);
    await rm(sockets, { recursive: true, force: true });
  };
  try {
    const client = new pg.Client({
      host: "127.0.0.1",
      port,
      user: "owner",
      password: ownerPassword,
      database: "postgres",
    });
    await client.connect();
    try {
      await client.query(`CREATE ROLE delegate LOGIN PASSWORD '${secrets.databasePassword}'`);
    } finally {
      await client.end();
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { port, close: stop };
}

async function startRuntime(operations) {
  const state = path.join(directory, "runtime");
  await mkdir(state);
  const child = spawn(process.execPath, [path.join(root, "packages/trust-runtime/dist/src/index.js")], {
    cwd: state,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: directory,
      TMPDIR: tmpdir(),
      TRUST_HOST: "127.0.0.1",
      TRUST_PORT: "0",
      TRUST_STORAGE: "pglite",
      TRUST_PGLITE_DIRECTORY: path.join(state, "pglite"),
      TRUST_SERVER_STATE_DIRECTORY: state,
      TRUST_OPERATIONS_DIRECTORY: operations,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const endpoint = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`TRUST runtime did not listen: ${stderr}`)), 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/TRUST runtime listening on (127\.0\.0\.1):(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(`http://${match[1]}:${match[2]}`);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`TRUST runtime exited with ${code}: ${stderr}`));
    });
  });
  return {
    endpoint,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

async function startHttpService() {
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    httpAuthorizations.push(authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: authorization === secrets.apiToken ? "yes" : "no", authorization }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/identity`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function startOtlpRecorder(target) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    otlpBodies.push(body);
    const forwarded = await fetch(target, {
      method: "POST",
      headers: Object.fromEntries(
        Object.entries(request.headers).filter(
          ([name]) => !["host", "content-length", "connection", "transfer-encoding"].includes(name),
        ),
      ),
      body,
    });
    const reply = Buffer.from(await forwarded.arrayBuffer());
    response.writeHead(forwarded.status, {
      "content-type": forwarded.headers.get("content-type") ?? "application/json",
    });
    response.end(reply);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/traces`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

const operationInterface = (environment, credential, produced) => `  Background: Operation interface
    Given Environment
      | name | type |
${environment.map(([name, type]) => `      | ${name} | ${type} |`).join("\n")}
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

const operationSources = {
  "credential.postgresql-identity": `# language: en
@trust-dsl:1 @operation:credential.postgresql-identity @version:1.0.0
Feature: Read the PostgreSQL role authenticated by a delegated Credential

${operationInterface([["databaseUrl", "string"]], "databasePassword", [["user", "string"]])}
  Scenario: Run
    When PostgreSQL "identity" executes SQL on Environment "databaseUrl"
        authenticated by Credential "databasePassword" with Input as JSONB parameter $1
      """
      SELECT jsonb_build_object('user', current_user, 'subject', ($1::jsonb)->>'subject') AS result
      """
    Then Produce with JSONata
      """
      { "user": steps.identity.result.user }
      """
`,
  "credential.http-bearer": `# language: en
@trust-dsl:1 @operation:credential.http-bearer @version:1.0.0
Feature: Call a service with a header taken from a delegated Credential

${operationInterface([["serviceUrl", "url"]], "apiToken", [
  ["accepted", "string"],
  ["echoed", "string"],
])}
  Scenario: Run
    When HTTP "call" sends "GET" to Environment "serviceUrl"
        with header "Authorization" from Credential "apiToken" and reads JSON
    Then Produce with JSONata
      """
      { "accepted": steps.call.body.accepted, "echoed": steps.call.body.authorization }
      """
`,
  "credential.shell-probe": `# language: en
@trust-dsl:1 @operation:credential.shell-probe @version:1.0.0
Feature: Report the process variables each Shell step receives

${operationInterface([["workspaceRoot", "directory"]], "shellToken", [
  ["declared", "string"],
  ["other", "string"],
])}
  Scenario: Run
    When Shell "declared" runs "node" with cwd from Environment "workspaceRoot"
        with variable "PROBE_VALUE" from Credential "shellToken"
      | argument  | source  |
      | probe.mjs | literal |
    And Shell "other" runs "node" with cwd from Environment "workspaceRoot"
      | argument  | source  |
      | probe.mjs | literal |
    Then Produce with JSONata
      """
      { "declared": steps.declared.stdout, "other": steps.other.stdout }
      """
`,
  "credential.shell-leak": `# language: en
@trust-dsl:1 @operation:credential.shell-leak @version:1.0.0
Feature: Fail after printing a delegated Credential

${operationInterface([["workspaceRoot", "directory"]], "shellToken", [["exit", "number"]])}
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
@trust-dsl:1 @procedure:credential-delegation @version:1.0.0
Feature: Delegate Environment Credentials to the steps that reference them

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Run the acceptance Operation. | Read a secret the Operation does not declare. |
    Given one reference "subject"

  @scenario:postgresql
  Scenario: Authenticate PostgreSQL
    Then Check "postgresql identity" runs Operation "credential.postgresql-identity@1.0.0" on "subject" as Input "subject" and must establish "the delegated role is connected"
      """js
      fact.user === "delegate" || fail("another role is connected")
      """

  @scenario:http
  Scenario: Call the service
    Then Check "http bearer" runs Operation "credential.http-bearer@1.0.0" on "subject" as Input "subject" and must establish "the service accepted the header"
      """js
      fact.accepted === "yes" || fail("the service refused the header")
      """

  @scenario:shell
  Scenario: Probe Shell variables
    Then Check "shell probe" runs Operation "credential.shell-probe@1.0.0" on "subject" as Input "subject" and must establish "the probe ran"
      """js
      fact.declared !== "" || fail("the probe printed nothing")
      """

  @scenario:leak
  Scenario: Fail after printing
    Then Check "shell leak" runs Operation "credential.shell-leak@1.0.0" on "subject" as Input "subject" and must establish "the command succeeded"
      """js
      fact.exit === 0 || fail("the command failed")
      """
`;
