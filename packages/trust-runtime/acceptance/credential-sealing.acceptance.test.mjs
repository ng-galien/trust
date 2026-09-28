import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { startPublicRuntime } from "../dist/acceptance/support/runtime-process.js";

const API_TOKEN = `sealing-api-${randomBytes(8).toString("hex")}`;
const LEGACY_TOKEN = `sealing-legacy-${randomBytes(8).toString("hex")}`;

const operation = `# language: en
@trust-dsl:1 @operation:sealed.call @version:1.0.0
Feature: Call a service with sealed Environment Credentials

  Background: Operation interface
    Given Environment
      | name       | type |
      | serviceUrl | url  |
    And Credentials
      | name        |
      | apiToken    |
      | legacyToken |
    And Input
      | input  | type      | cardinality |
      | target | reference | one         |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "call" sends "GET" to Environment "serviceUrl"
        with header "Authorization" from Credential "apiToken"
        with header "X-Legacy" from Credential "legacyToken" and reads JSON
    Then Produce with JSONata
      """
      { "status": steps.call.status }
      """
`;

const procedure = `# language: en
@trust-dsl:1 @procedure:credential-sealing @version:1.0.0
Feature: Use Credentials sealed at rest

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Call the declared service. | Use a Credential the Operation does not declare. |
    Given one reference "subject"

  @scenario:sealed-call
  Scenario: Call the service
    Then Check "sealed call" runs Operation "sealed.call@*" on "subject" as Input "target" and must establish "the service answered"
      """js
      fact.status === 200 || fail("the service did not answer")
      """
`;

let directory;
let operationsDirectory;
let storage;
let keyFile;
let runtime;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "trust-credential-sealing-"));
  operationsDirectory = path.join(directory, "operations");
  await mkdir(operationsDirectory);
  await writeFile(path.join(operationsDirectory, "sealed.call.feature"), operation);
  storage = { kind: "pglite", directory: path.join(directory, "pglite") };
  keyFile = path.join(directory, "keys", "credential.key");
});

after(async () => {
  await runtime?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function start(credentialKeyFile, environments) {
  return startPublicRuntime("trust-credential-sealing-", {
    storage,
    operationsDirectory,
    processEnvironment: { TRUST_CREDENTIAL_KEY_FILE: credentialKeyFile },
    ...(environments ? { environments } : {}),
  });
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

/** Reads or changes the stored rows while no runtime owns the embedded store. */
async function withStore(action) {
  const database = await PGlite.create({ dataDir: storage.directory });
  try {
    return await action(database);
  } finally {
    await database.close();
  }
}

const storedCredentials = () =>
  withStore(async (database) =>
    Object.fromEntries(
      (await database.query("SELECT name, value FROM environment_credentials ORDER BY name")).rows.map((row) => [
        row.name,
        row.value,
      ]),
    ),
  );

test("Environment credentials are sealed at rest with an owner-only key file and survive a restart", async () => {
  runtime = await start(keyFile, { production: { serviceUrl: "http://127.0.0.1:9/service" } });
  await rpc("procedure.publish", { source: procedure, sourceName: "credential-sealing.feature" });
  await rpc("credential.save", { environment: "production", name: "apiToken", value: API_TOKEN });
  assert.equal((await stat(keyFile)).mode & 0o777, 0o600, "the generated key file is readable only by its owner");
  await runtime.close();
  runtime = undefined;

  const sealed = await storedCredentials();
  assert.match(sealed.apiToken, /^trust-sealed:v1:/u, "the stored value is a sealed envelope");
  assert.equal(sealed.apiToken.includes(API_TOKEN), false, "the stored value never holds the plaintext");
  assert.equal(
    Buffer.from(sealed.apiToken.slice("trust-sealed:v1:".length), "base64").includes(API_TOKEN),
    false,
    "the envelope payload is not the plaintext",
  );

  // A value stored before sealing existed is sealed in place at the next start.
  await withStore((database) =>
    database.query(
      "INSERT INTO environment_credentials (environment, name, value, updated_at) VALUES ($1, $2, $3, now())",
      ["production", "legacyToken", LEGACY_TOKEN],
    ),
  );

  runtime = await start(keyFile);
  const catalog = await rpc("credential.list", { environment: "production" });
  assert.equal(JSON.stringify(catalog).includes(API_TOKEN), false, "the catalog returns names only");
  const engagement = await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "credential-sealing",
    procedureVersion: "1.0.0",
    plan: "sealed-after-restart",
    environment: "production",
    rootInputs: { subject: "service" },
    mode: "live",
  });
  const admission = await rpc("check.attempt.admit", {
    contract: "trust.check-admission-request@1",
    attemptKey: "sealed-after-restart-attempt",
    checkUri: engagement.checkUris[0],
  });
  assert.equal(admission.status, "ADMITTED", JSON.stringify(admission.reason ?? admission.status));
  assert.equal(admission.credentials.apiToken, API_TOKEN, "a sealed credential is opened for admission after restart");
  assert.equal(admission.credentials.legacyToken, LEGACY_TOKEN, "a legacy value remains usable after sealing");
  await runtime.close();
  runtime = undefined;

  const resealed = await storedCredentials();
  assert.match(resealed.legacyToken, /^trust-sealed:v1:/u, "the legacy plaintext value is now sealed");
  assert.equal(resealed.legacyToken.includes(LEGACY_TOKEN), false);
});

test("a runtime refuses to start with a foreign or exposed credential key file", async () => {
  const foreignKey = path.join(directory, "foreign.key");
  await writeFile(foreignKey, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  await assert.rejects(start(foreignKey), /cannot be opened with the configured credential key file/u);

  const exposedKey = path.join(directory, "exposed.key");
  await writeFile(exposedKey, `${randomBytes(32).toString("base64")}\n`, { mode: 0o644 });
  await assert.rejects(start(exposedKey), /readable only by its owner/u);

  const sealed = await storedCredentials();
  assert.match(sealed.apiToken, /^trust-sealed:v1:/u, "a refused start leaves the sealed values unchanged");
});
