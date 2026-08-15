import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";

import type {
  SkillAttemptAdmissionResult,
  SkillFinalizationResult,
} from "../src/application/plan-runtime-service.js";
import type { RegistryPrincipalConfiguration } from "../src/ports/registry-authority.js";
import type {
  JsonRpcResponse,
  PlanEngagementResultDto,
  ProcedureDefinitionPublicationResult,
} from "../src/presentation/rpc-contract.js";
import { otlpFactAttributes } from "./support/otlp-fact.js";
import { startPublicRuntime } from "./support/runtime-process.js";

const prepareCapability = "workflow.prepare";
const publishCapability = "workflow.publish";
const environment = "trust-test";
const deploymentKey = "workflow-runner";
const releaseDigest = `sha256:${"c".repeat(64)}`;
const distributionDigest = `sha256:${"e".repeat(64)}`;
const publisherIdentity = "spiffe://trust-test/skill-publishers/workflow";
const distributionVerifierIdentity = "spiffe://trust-test/distribution-verifiers/workflow";
const operatorIdentity = "spiffe://trust-test/operators/precedence";
const observerIdentity = "spiffe://trust-test/observers/precedence";
const runtimeIdentity = "spiffe://trust-test/skill-runtimes/workflow";
const processIdentity = "urn:uuid:00000000-0000-4000-8000-000000000091";

const credentials = {
  publisher: "precedence-publisher-credential",
  distributionVerifier: "precedence-distribution-verifier-credential",
  operator: "precedence-operator-credential",
  observer: "precedence-observer-credential",
  runtime: "precedence-runtime-credential",
  process: "precedence-process-credential",
} as const;

const distributionVerifierKeys = generateKeyPairSync("ed25519");
const procedureSource = `# language: en
@trust-dsl:1 @procedure:action-precedence @version:1.0.0
Feature: Run a publication only after its preparation is validated
  The second Skill action is actionable only after TRUST validates the first Check.

  Background: Procedure interface
    Given Skill capability "workflow.prepare" performs read and is replayable
    And Skill capability "workflow.prepare" accepts
      | input               | type      | cardinality |
      | work item           | reference | one         |
      | publication channel | reference | one         |
    And Skill capability "workflow.prepare" reports
      | observation | type   | cardinality | domain                        |
      | status      | string | one         | enum "ready", "not-ready" |
    And Skill capability "workflow.prepare" exposes no outputs

    And Skill capability "workflow.publish" performs read and is replayable
    And Skill capability "workflow.publish" accepts
      | input     | type      | cardinality |
      | work item | reference | one         |
    And Skill capability "workflow.publish" reports
      | observation | type   | cardinality | domain                                |
      | status      | string | one         | enum "published", "not-published" |
    And Skill capability "workflow.publish" exposes no outputs

    Given one "work item"
    And one "publication channel"

  @scenario:preparation
  Scenario: Prepare the work item
    Then Check "preparation" uses Skill capability "workflow.prepare" on "work item" as input "work item" using "publication channel" as input "publication channel" and must establish "the work item is prepared"
      | observation | relation | expectation | failure feedback                 |
      | status      | equals   | literal "ready" | "the work item is not prepared" |
    And the scenario is verified when all Skill actions are validated

  @scenario:publication
  Scenario: Publish only after preparation
    Given scenario "preparation" is validated
    Then Check "publication" uses Skill capability "workflow.publish" on "work item" as input "work item" and must establish "the work item is published"
      | observation | relation | expectation | failure feedback                  |
      | status      | equals   | literal "published" | "the work item is not published" |
    And the scenario is verified when all Skill actions are validated
`;

test("a scenario dependency refuses the next Check until the preceding scenario is validated", async (context) => {
  const runtime = await startPublicRuntime("trust-action-precedence-", {
    maxClockSkewMs: 5_000,
    maxLeaseDurationMs: 120_000,
    maxProbeAgeMs: 120_000,
    registryPrincipalConfigurations: [
      principal(publisherIdentity, ["publisher"], credentials.publisher),
      principal(
        distributionVerifierIdentity,
        ["distribution-verifier"],
        credentials.distributionVerifier,
        distributionVerifierKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
      principal(operatorIdentity, ["operator"], credentials.operator),
      principal(observerIdentity, ["observer"], credentials.observer),
      principal(runtimeIdentity, ["runtime"], credentials.runtime),
      principal(processIdentity, ["runtime-process"], credentials.process),
    ],
  });
  context.after(() => runtime.close());

  const published = await rpc<ProcedureDefinitionPublicationResult>(
    runtime.endpoint,
    "procedure.definition.publish",
    {
      source: procedureSource,
      sourceName: "action-precedence.feature",
    },
    credentials.publisher,
  );
  const requirements = new Map(
    published.definition.requiredCapabilities.map((item) => [item.capability, item]),
  );
  const prepareRequirement = requiredRequirement(requirements, prepareCapability);
  const publishRequirement = requiredRequirement(requirements, publishCapability);

  const release = {
    contract: "trust.skill-release@1" as const,
    skill: "trust.workflow",
    version: "1.0.0",
    releaseDigest,
    publisher: publisherIdentity,
    implements: [
      { capability: prepareCapability, actionContractDigest: prepareRequirement.actionContractDigest },
      { capability: publishCapability, actionContractDigest: publishRequirement.actionContractDigest },
    ],
    entrypoints: { cli: "bin/trust-workflow" },
    probes: ["runtime-ready"],
  };
  await rpc(runtime.endpoint, "skill.release.claim", { release }, credentials.publisher);
  const distribution = {
    contract: "trust.verified-skill-distribution@1" as const,
    releaseDigest,
    distributionDigest,
    issuer: distributionVerifierIdentity,
    verifiedAt: new Date().toISOString(),
  };
  await rpc(runtime.endpoint, "skill.distribution.record-verified", {
    distribution: {
      ...distribution,
      signature: signRecord(distribution, distributionVerifierKeys.privateKey),
    },
  }, credentials.distributionVerifier);

  await rpc(runtime.endpoint, "skill.release.authorization.set", {
    environment,
    releaseDigest,
    decision: "ALLOW",
  }, credentials.operator);
  await rpc(runtime.endpoint, "skill.deployment.authorization.set", {
    environment,
    deploymentKey,
    releaseDigest,
    envelope: "cli",
    runtimeIdentity,
    decision: "ALLOW",
  }, credentials.operator);
  for (const requirement of [prepareRequirement, publishRequirement]) {
    await rpc(runtime.endpoint, "skill.deployment.selection.set", {
      environment,
      requirement: {
        capability: requirement.capability,
        actionContractDigest: requirement.actionContractDigest,
      },
      deploymentKey,
    }, credentials.operator);
  }

  const announcedAt = new Date();
  await rpc(runtime.endpoint, "skill.deployment.announce", {
    announcement: {
      environment,
      deploymentKey,
      envelope: "cli",
      runtimeIdentity,
      processIdentity,
      releaseDigest,
      distributionDigest,
      probes: [{
        name: "runtime-ready",
        status: "PASS",
        reason: "available",
        observedAt: announcedAt.toISOString(),
      }],
      announcedAt: announcedAt.toISOString(),
      leaseExpiresAt: new Date(announcedAt.getTime() + 60_000).toISOString(),
    },
  }, credentials.runtime, credentials.process);

  const engagement = await rpc<PlanEngagementResultDto>(runtime.endpoint, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "action-precedence",
    procedureVersion: "1.0.0",
    plan: "precedence-plan",
    environment,
    rootInputs: {
      "work item": "order-42",
      "publication channel": "public-api",
    },
  }, credentials.operator);
  const prepareCheckUri =
    "trust://localhost:4318/action-precedence@1.0.0/precedence-plan/preparation/workflow-prepare";
  const publishCheckUri =
    "trust://localhost:4318/action-precedence@1.0.0/precedence-plan/publication/workflow-publish";
  assert.deepEqual(engagement.checkUris, [prepareCheckUri, publishCheckUri]);

  const prematureRequest = admissionRequest("publish-attempt", publishCheckUri);
  const premature = await rpc<SkillAttemptAdmissionResult>(
    runtime.endpoint,
    "skill.attempt.admit",
    prematureRequest,
    credentials.runtime,
    credentials.process,
  );
  assert.deepEqual(premature, {
    contract: "trust.skill-admission@1",
    status: "REFUSED",
    attemptKey: "publish-attempt",
    reasonCode: "check-not-actionable",
    reason: "the Check dependencies are not yet satisfied",
  });

  const prepare = await rpc<SkillAttemptAdmissionResult>(
    runtime.endpoint,
    "skill.attempt.admit",
    admissionRequest("prepare-attempt", prepareCheckUri),
    credentials.runtime,
    credentials.process,
  );
  assert.equal(prepare.status, "ADMITTED");
  if (prepare.status !== "ADMITTED") assert.fail("the first action must be admitted");

  const traceResponse = await fetch(`${runtime.endpoint}/v1/traces`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.runtime}`,
      "x-trust-process-authorization": `Bearer ${credentials.process}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(otlpFactTrace({
      attemptKey: "prepare-attempt",
      executionHandle: prepare.executionHandle,
      checkUri: prepareCheckUri,
      fact: {
        kind: prepareCapability,
        observedAt: new Date().toISOString(),
        values: { status: "ready" },
      },
    })),
  });
  assert.equal(traceResponse.status, 200);
  assert.deepEqual(await traceResponse.json(), {});

  const finalized = await rpc<SkillFinalizationResult>(
    runtime.endpoint,
    "skill.attempt.finalize",
    {
      contract: "trust.skill-finalization-request@1",
      executionHandle: prepare.executionHandle,
    },
    credentials.runtime,
    credentials.process,
  );
  assert.equal(finalized.verdict, "VALIDATED");

  const admittedAfterPrecedence = await rpc<SkillAttemptAdmissionResult>(
    runtime.endpoint,
    "skill.attempt.admit",
    prematureRequest,
    credentials.runtime,
    credentials.process,
  );
  assert.equal(admittedAfterPrecedence.status, "ADMITTED");
  if (admittedAfterPrecedence.status !== "ADMITTED") {
    assert.fail("the dependent action must become admissible after VALIDATED");
  }
  assert.equal(admittedAfterPrecedence.checkUri, publishCheckUri);
  assert.equal(admittedAfterPrecedence.capability, publishCapability);
});

function admissionRequest(attemptKey: string, checkUri: string) {
  return {
    contract: "trust.skill-admission-request@1" as const,
    attemptKey,
    checkUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli" as const,
    runtimeIdentity,
    processIdentity,
  };
}

function otlpFactTrace(input: {
  attemptKey: string;
  executionHandle: string;
  checkUri: string;
  fact: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const timeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
  const stringAttribute = (key: string, value: string) => ({
    key,
    value: { stringValue: value },
  });
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          stringAttribute("trust.skill.release_digest", releaseDigest),
          stringAttribute("trust.skill.runtime_identity", runtimeIdentity),
          stringAttribute("trust.skill.process_identity", processIdentity),
          stringAttribute("trust.skill.environment", environment),
          stringAttribute("trust.skill.deployment_key", deploymentKey),
          stringAttribute("trust.skill.envelope", "cli"),
        ],
      },
      scopeSpans: [{
        spans: [{
          name: "trust.skill.facts",
          startTimeUnixNano: timeUnixNano,
          attributes: [
            stringAttribute("trust.attempt_key", input.attemptKey),
            stringAttribute("trust.execution_handle", input.executionHandle),
            stringAttribute("trust.check_uri", input.checkUri),
          ],
          events: [{
            name: "trust.skill.fact",
            attributes: otlpFactAttributes(input.fact, 0),
          }],
        }],
      }],
    }],
  };
}

async function rpc<Result>(
  endpoint: string,
  method: string,
  params: unknown,
  credential?: string,
  processCredential?: string,
): Promise<Result> {
  const id = `action-precedence-${method}`;
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      ...(processCredential === undefined
        ? {}
        : { "x-trust-process-authorization": `Bearer ${processCredential}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as JsonRpcResponse<Result>;
  assert.equal(body.id, id);
  if ("error" in body) {
    assert.fail(`unexpected ${method} error: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

function principal(
  identity: string,
  roles: RegistryPrincipalConfiguration["roles"],
  credential: string,
  publicKey?: string,
): RegistryPrincipalConfiguration {
  return {
    identity,
    roles,
    credentialSha256: `sha256:${digest(credential)}`,
    ...(publicKey === undefined ? {} : { publicKey }),
  };
}

function requiredRequirement(
  values: ReadonlyMap<string, {
    readonly capability: string;
    readonly actionContractDigest: string;
  }>,
  capability: string,
) {
  const value = values.get(capability);
  assert.notEqual(value, undefined, `${capability} must have a compiled capability requirement`);
  return value as NonNullable<typeof value>;
}

function signRecord(value: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalJson(value), "utf8"), privateKey).toString("base64");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
