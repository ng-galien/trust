import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { startPublicRuntime } from "../dist/acceptance/support/runtime-process.js";

const API_TOKEN = "sec010-api-4b7d2c9e";
const DEPLOY_TOKEN = "sec010-deploy-91af03";
const UNRELATED_TOKEN = "sec010-unrelated-5e22";

const secretOperation = `# language: en
@trust-dsl:1 @operation:secret.call @version:1.0.0
Feature: Call a service and deploy with Environment Credentials

  Background: Operation interface
    Given Environment
      | name       | type      |
      | serviceUrl | url       |
      | root       | directory |
    And Credentials
      | name        |
      | apiToken    |
      | deployToken |
    And Input
      | input  | type      | cardinality |
      | target | reference | one         |
    And Produced fields
      | field  | type   | cardinality | domain |
      | status | number | one         | any    |

  Scenario: Run
    When HTTP "call" sends "GET" to Environment "serviceUrl"
        with header "Authorization" from Credential "apiToken" and reads JSON
    And Shell "deploy" runs "deploy" with cwd from Environment "root"
        with variable "DEPLOY_TOKEN" from Credential "deployToken"
      | argument |
      | now      |
    Then Produce with JSONata
      """
      { "status": steps.call.status }
      """
`;

const plainOperation = `# language: en
@trust-dsl:1 @operation:plain.read @version:1.0.0
Feature: Read a directory without Credentials

  Background: Operation interface
    Given Environment
      | name | type      |
      | root | directory |
    And Input
      | input  | type      | cardinality |
      | target | reference | one         |
    And Produced fields
      | field  | type   | cardinality | domain |
      | listed | string | one         | any    |

  Scenario: Run
    When Shell "list" runs "ls" with cwd from Environment "root"
      | argument |
      | .        |
    Then Produce with JSONata
      """
      { "listed": steps.list.stdout }
      """
`;

const procedure = `# language: en
@trust-dsl:1 @procedure:credential-delegation @version:1.0.0
Feature: Delegate Environment Credentials to admitted Checks

  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all   | Call the declared service. | Use a Credential the Operation does not declare. |
    Given one reference "subject"

  @scenario:secret-call
  Scenario: Call the service
    Then Check "secret call" runs Operation "secret.call@*" on "subject" as Input "target" and must establish "the service answered"
      """js
      fact.status === 200 || fail("the service did not answer")
      """

  @scenario:plain-read
  Scenario: Read the directory
    Then Check "plain read" runs Operation "plain.read@*" on "subject" as Input "target" and must establish "the directory is listed"
      """js
      fact.listed.length > 0 || fail("the directory is empty")
      """
`;

let runtime;
let directory;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "trust-credential-delegation-"));
  const operationsDirectory = path.join(directory, "operations");
  await mkdir(operationsDirectory);
  await writeFile(path.join(operationsDirectory, "secret.call.feature"), secretOperation);
  await writeFile(path.join(operationsDirectory, "plain.read.feature"), plainOperation);
  runtime = await startPublicRuntime("trust-credential-delegation-", {
    operationsDirectory,
    environments: {
      provisioned: { serviceUrl: "http://127.0.0.1:9/service", root: directory },
      lacking: { serviceUrl: "http://127.0.0.1:9/service", root: directory },
    },
  });
  await rpc("procedure.publish", { source: procedure, sourceName: "credential-delegation.feature" });
  await rpc("credential.save", { environment: "provisioned", name: "apiToken", value: API_TOKEN });
  await rpc("credential.save", { environment: "provisioned", name: "deployToken", value: DEPLOY_TOKEN });
  await rpc("credential.save", { environment: "provisioned", name: "unrelatedToken", value: UNRELATED_TOKEN });
  await rpc("credential.save", { environment: "lacking", name: "apiToken", value: API_TOKEN });
  await rpc("credential.save", { environment: "lacking", name: "unrelatedToken", value: UNRELATED_TOKEN });
});

after(async () => {
  await runtime?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function envelope(method, params) {
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function rpc(method, params) {
  const result = await envelope(method, params);
  assert.equal(result.error, undefined, `${method}: ${JSON.stringify(result.error)}`);
  return result.result;
}

async function engage(plan, environment, mode) {
  const engagement = await rpc("plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "credential-delegation",
    procedureVersion: "1.0.0",
    plan,
    environment,
    rootInputs: { subject: "service" },
    mode,
  });
  const find = (name) => {
    const uri = engagement.checkUris.find((candidate) => candidate.includes(`/${name}/`));
    assert.ok(uri, `${name} Check URI in ${JSON.stringify(engagement.checkUris)}`);
    return uri;
  };
  return { secret: find("secret-call"), plain: find("plain-read") };
}

function admit(checkUri, attemptKey) {
  return rpc("check.attempt.admit", { contract: "trust.check-admission-request@1", attemptKey, checkUri });
}

async function publicProjections(plan, checkUris) {
  const outputs = [JSON.stringify(await rpc("plan.read", { plan }))];
  for (const checkUri of checkUris)
    outputs.push(JSON.stringify(await rpc("check.read", { contract: "trust.check-read-request@1", checkUri })));
  return outputs.join("\n");
}

test("SEC-010 AC3 only the credentials declared by the admitted Operation are delegated and a dry-run receives none", async () => {
  const live = await engage("live-delegation", "provisioned", "live");

  const secret = await admit(live.secret, "live-secret-attempt");
  assert.equal(secret.status, "ADMITTED", JSON.stringify(secret));
  assert.equal(secret.contract, "trust.check-admission@1");
  assert.deepEqual(secret.operation.credentials, ["apiToken", "deployToken"]);
  assert.deepEqual(secret.credentials, { apiToken: API_TOKEN, deployToken: DEPLOY_TOKEN });
  assert.deepEqual(Object.keys(secret.environment).sort(), ["root", "serviceUrl"]);
  const environmentText = JSON.stringify(secret.environment);
  for (const value of [API_TOKEN, DEPLOY_TOKEN, UNRELATED_TOKEN]) {
    assert.equal(environmentText.includes(value), false, "no Credential value travels inside environment");
  }
  assert.equal(JSON.stringify(secret).includes(UNRELATED_TOKEN), false, "an undeclared Credential is not delegated");

  const replayed = await admit(live.secret, "live-secret-attempt");
  assert.equal(replayed.attemptHandle, secret.attemptHandle, "admission is idempotent per attempt key");
  assert.deepEqual(replayed.credentials, { apiToken: API_TOKEN, deployToken: DEPLOY_TOKEN });

  const plain = await admit(live.plain, "live-plain-attempt");
  assert.equal(plain.status, "ADMITTED", JSON.stringify(plain));
  assert.equal("credentials" in plain.operation, false);
  assert.deepEqual(plain.credentials, {}, "an Operation without declarations receives no Credential");
  assert.deepEqual(Object.keys(plain.environment), ["root"]);

  const dryRun = await engage("dry-delegation", "provisioned", "dry-run");
  for (const [checkUri, attemptKey] of [
    [dryRun.secret, "dry-secret-attempt"],
    [dryRun.plain, "dry-plain-attempt"],
  ]) {
    const rehearsal = await admit(checkUri, attemptKey);
    assert.equal(rehearsal.status, "ADMITTED", JSON.stringify(rehearsal));
    assert.deepEqual(rehearsal.credentials, {}, "a dry-run receives no Credential");
    assert.deepEqual(rehearsal.environment, {});
    const text = JSON.stringify(rehearsal);
    for (const value of [API_TOKEN, DEPLOY_TOKEN, UNRELATED_TOKEN]) assert.equal(text.includes(value), false);
  }

  const projections = [
    await publicProjections("live-delegation", [live.secret, live.plain]),
    await publicProjections("dry-delegation", [dryRun.secret, dryRun.plain]),
  ].join("\n");
  assert.match(projections, /secret call/, "the projections describe the admitted Checks");
  for (const value of [API_TOKEN, DEPLOY_TOKEN, UNRELATED_TOKEN]) {
    assert.equal(projections.includes(value), false, "Plan and Check projections never carry a Credential value");
  }
});

test("SEC-030 AC2 a declared credential missing from the Environment refuses admission before any external action", async () => {
  const live = await engage("live-lacking", "lacking", "live");

  const refusal = await admit(live.secret, "lacking-secret-attempt");
  assert.equal(refusal.contract, "trust.check-admission@1");
  assert.equal(refusal.status, "REFUSED", JSON.stringify(refusal));
  assert.equal(refusal.reasonCode, "credential-missing");
  assert.equal(
    refusal.reason,
    'Environment "lacking" lacks the Credential "deployToken" declared by Operation "secret.call@1.0.0"',
  );
  assert.deepEqual(refusal.next, { action: "READ_PLAN" });
  for (const field of ["attemptHandle", "executionId", "operation", "environment", "credentials"]) {
    assert.equal(field in refusal, false, `a refusal carries no ${field}: nothing can be executed`);
  }
  assert.equal(JSON.stringify(refusal).includes(API_TOKEN), false, "a refusal never discloses a present Credential");

  const checkRead = await rpc("check.read", { contract: "trust.check-read-request@1", checkUri: live.secret });
  const checkText = JSON.stringify(checkRead);
  assert.equal(checkText.includes("lacking-secret-attempt"), false, "the refused admission created no Attempt");

  const facts = await envelope("check.attempt.facts", {
    attemptKey: "lacking-secret-attempt",
    attemptHandle: "00000000-0000-4000-8000-000000000000",
    checkUri: live.secret,
    recordedAt: new Date().toISOString(),
    facts: [{ kind: "secret.call", observedAt: new Date().toISOString(), values: { status: 200 } }],
  });
  assert.notEqual(facts.error, undefined, "no Attempt exists to receive Facts");

  const plain = await admit(live.plain, "lacking-plain-attempt");
  assert.equal(plain.status, "ADMITTED", "an Operation that declares no Credential is still admitted");
  assert.deepEqual(plain.credentials, {});

  const dryRun = await engage("dry-lacking", "lacking", "dry-run");
  const rehearsal = await admit(dryRun.secret, "dry-lacking-attempt");
  assert.equal(rehearsal.status, "ADMITTED", "a dry-run needs and receives no Credential");
  assert.deepEqual(rehearsal.credentials, {});

  await rpc("credential.save", { environment: "lacking", name: "deployToken", value: DEPLOY_TOKEN });
  const provisioned = await admit(live.secret, "lacking-secret-attempt");
  assert.equal(provisioned.status, "ADMITTED", "the same attempt key is free because nothing was bound to it");
  assert.deepEqual(provisioned.credentials, { apiToken: API_TOKEN, deployToken: DEPLOY_TOKEN });

  await rpc("credential.remove", { environment: "lacking", name: "deployToken" });
  const withdrawn = await admit(live.secret, "lacking-secret-attempt");
  assert.equal(withdrawn.status, "REFUSED", "a pending Attempt is re-admitted only while its Credentials exist");
  assert.equal(withdrawn.reasonCode, "credential-missing");
});
