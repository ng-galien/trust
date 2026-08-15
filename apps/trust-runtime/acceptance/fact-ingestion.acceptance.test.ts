import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import type { RegistryPrincipalConfiguration } from "../src/ports/registry-authority.js";
import { otlpFactAttributes } from "./support/otlp-fact.js";
import { startPublicRuntime } from "./support/runtime-process.js";

const capability = "acceptance.required-observations";
const consumerCapability = "acceptance.check-observation-consumer";
const releaseDigest = `sha256:${"c".repeat(64)}`;
const distributionDigest = `sha256:${"e".repeat(64)}`;
const environment = "fact-ingestion-test";
const deploymentKey = "required-observations";
const publisherIdentity = "spiffe://acceptance.example/skill-publishers/required-observations";
const distributionVerifierIdentity =
  "spiffe://acceptance.example/distribution-verifiers/required-observations";
const operatorIdentity = "spiffe://acceptance.example/operators/fact-ingestion";
const observerIdentity = "spiffe://acceptance.example/observers/fact-ingestion";
const runtimeIdentity = "spiffe://acceptance.example/skill-runtimes/required-observations";
const processIdentity = "urn:uuid:00000000-0000-4000-8000-000000000021";

const credentials = {
  publisher: "fact_ingestion_publisher_credential",
  distributionVerifier: "fact_ingestion_distribution_verifier_credential",
  operator: "fact_ingestion_operator_credential",
  observer: "fact_ingestion_observer_credential",
  runtime: "fact_ingestion_runtime_credential",
  process: "fact_ingestion_process_credential",
} as const;

const procedureSource = `# language: en
@procedure:required-observations @version:1.0.0 @trust-dsl:1
Feature: Require complete correlated observations before accepting Facts

  Background: Procedure interface
    Given Skill capability "acceptance.required-observations" performs read and is replayable
    And Skill capability "acceptance.required-observations" accepts
      | input              | type      | cardinality                             |
      | candidate project  | reference | many                                    |
      | candidate revision | reference | one for each input "candidate project" |
    And Skill capability "acceptance.required-observations" reports
      | observation     | type      | cardinality                                | domain                        |
      | tested project  | reference | many                                       | any                           |
      | tested revision | reference | one for each observation "tested project" | any                           |
      | result status   | string    | one                                        | enum "accepted", "rejected" |
      | qualification token | string | one                                        | any                           |
    And Skill capability "acceptance.required-observations" exposes outputs
      | output | from observation | parents |

    And Skill capability "acceptance.check-observation-consumer" performs read and is replayable
    And Skill capability "acceptance.check-observation-consumer" accepts
      | input   | type      | cardinality |
      | subject | reference | one         |
    And Skill capability "acceptance.check-observation-consumer" reports
      | observation    | type   | cardinality | domain |
      | observed token | string | one         | any    |
    And Skill capability "acceptance.check-observation-consumer" exposes outputs
      | output | from observation | parents |
    And many "candidate project"
    And one "candidate revision" for each "candidate project"
    And one "observation subject" fixed as "observation-subject"

  @scenario:qualify-work-item
  Scenario: Every project was tested at its own revision
    Then Check "qualification result" uses Skill capability "acceptance.required-observations" on all "candidate project" as input "candidate project" using all "candidate revision" as input "candidate revision" and must establish "every candidate revision was accepted"
      | observation     | relation | expectation                  | failure feedback                                |
      | tested project  | equals   | context "candidate project"  | "another set of projects was tested"          |
      | tested revision | equals   | context "candidate revision" | "a project was tested at another revision"     |
      | result status   | equals   | literal "accepted"           | "the correlated result status is not accepted" |
    And the scenario is verified when all Skill actions are validated

  @scenario:consume-check-observation
  Scenario: Consume the exact active upstream Check observation
    Given scenario "qualify-work-item" is validated
    Then Check "observation consumption" uses Skill capability "acceptance.check-observation-consumer" on "observation subject" as input "subject" and must establish "the active Check observation was consumed"
      | observation    | relation | expectation                                               | failure feedback                       |
      | observed token | equals   | observation "qualification token" from Check "qualification result" | "another Check observation was consumed" |
    And the scenario is verified when all Skill actions are validated
`;

test("OTLP rejects an incomplete predicate observation set atomically and permits re-observation", {
  timeout: 30_000,
}, async (context) => {
  const distributionVerifierKeys = generateKeyPairSync("ed25519");
  const runtime = await startPublicRuntime("trust-fact-ingestion-", {
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

  const published = await rpc<{
    readonly definition: {
      readonly requiredCapabilities: readonly {
        readonly capability: string;
        readonly actionContractDigest: string;
      }[];
    };
  }>(runtime.endpoint, "procedure.definition.publish", {
    source: procedureSource,
    sourceName: "required-observations.feature",
  }, { authorization: credentials.publisher });
  const requirements = new Map(
    published.definition.requiredCapabilities.map((item) => [item.capability, item]),
  );
  const requirement = requirements.get(capability);
  const consumerRequirement = requirements.get(consumerCapability);
  assert.ok(requirement);
  assert.ok(consumerRequirement);
  assert.equal(requirement.capability, capability);
  const actionContractDigest = requirement.actionContractDigest;
  assert.match(actionContractDigest, /^[0-9a-f]{64}$/);

  const release = {
    contract: "trust.skill-release@1",
    skill: "trust.required-observations",
    version: "1.0.0",
    releaseDigest,
    publisher: publisherIdentity,
    implements: [...requirements.values()].map((item) => ({
      capability: item.capability,
      actionContractDigest: item.actionContractDigest,
    })),
    entrypoints: { cli: "bin/trust-required-observations" },
    probes: ["runtime-ready"],
  };
  await rpc(runtime.endpoint, "skill.release.claim", { release }, {
    authorization: credentials.publisher,
  });
  const distribution = signRegistryRecord({
    contract: "trust.verified-skill-distribution@1",
    releaseDigest,
    distributionDigest,
    issuer: distributionVerifierIdentity,
    verifiedAt: new Date().toISOString(),
  }, distributionVerifierKeys.privateKey);
  await rpc(runtime.endpoint, "skill.distribution.record-verified", { distribution }, {
    authorization: credentials.distributionVerifier,
  });
  await rpc(runtime.endpoint, "skill.release.authorization.set", {
    environment,
    releaseDigest,
    decision: "ALLOW",
  }, { authorization: credentials.operator });
  await rpc(runtime.endpoint, "skill.deployment.authorization.set", {
    environment,
    deploymentKey,
    releaseDigest,
    envelope: "cli",
    runtimeIdentity,
    decision: "ALLOW",
  }, { authorization: credentials.operator });
  for (const item of requirements.values()) {
    await rpc(runtime.endpoint, "skill.deployment.selection.set", {
      environment,
      requirement: {
        capability: item.capability,
        actionContractDigest: item.actionContractDigest,
      },
      deploymentKey,
    }, { authorization: credentials.operator });
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
        reason: "acceptance runtime is ready",
        observedAt: announcedAt.toISOString(),
      }],
      announcedAt: announcedAt.toISOString(),
      leaseExpiresAt: new Date(announcedAt.getTime() + 60_000).toISOString(),
    },
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });

  const engagement = await rpc<{
    readonly status: string;
    readonly checkUris: readonly string[];
  }>(runtime.endpoint, "plan.engage", {
    contract: "trust.plan-engagement-request@1",
    procedure: "required-observations",
    procedureVersion: "1.0.0",
    plan: "work-plan-21",
    environment,
    rootInputs: {
      "candidate project": ["project-b", "project-a"],
      "candidate revision": [
        {
          value: "revision-a",
          parents: [{ role: "candidate project", value: "project-a" }],
        },
        {
          value: "revision-b",
          parents: [{ role: "candidate project", value: "project-b" }],
        },
      ],
    },
  }, { authorization: credentials.operator });
  assert.equal(engagement.status, "ENGAGED");
  assert.equal(engagement.checkUris.length, 2);
  const checkUri = engagement.checkUris.find((uri) =>
    uri.endsWith("/acceptance-required-observations")
  );
  assert.ok(checkUri);
  const consumerCheckUri = engagement.checkUris.find((uri) => uri !== checkUri);
  assert.ok(consumerCheckUri);
  const mcp = await initializeMcp(runtime.endpoint, credentials.observer);
  const initiallyBlockedConsumer = await callMcpText(mcp, "trust_check_read", {
    checkUri: consumerCheckUri,
  });
  assert.match(initiallyBlockedConsumer, /^Status: OPEN$/m);
  assert.match(initiallyBlockedConsumer, /^Actionable: no$/m);
  assert.match(
    initiallyBlockedConsumer,
    new RegExp(`^Blocked by: \\["${escapeRegExp(checkUri)}"\\]$`, "m"),
  );

  const attemptKey = "required-observations-attempt-1";
  const admission = await rpc<{
    readonly status: string;
    readonly executionHandle: string;
    readonly actionInput: Readonly<Record<string, unknown>>;
  }>(runtime.endpoint, "skill.attempt.admit", {
    contract: "trust.skill-admission-request@1",
    attemptKey,
    checkUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli",
    runtimeIdentity,
    processIdentity,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  assert.equal(admission.status, "ADMITTED");
  assert.deepEqual(admission.actionInput, {
    "candidate project": ["project-a", "project-b"],
    "candidate revision": [
      {
        value: "revision-a",
        parents: [{ kind: "input", port: "candidate project", value: "project-a" }],
      },
      {
        value: "revision-b",
        parents: [{ kind: "input", port: "candidate project", value: "project-b" }],
      },
    ],
  });
  const observedAt = new Date().toISOString();
  const incompleteTrace = otlpTrace({
    attemptKey,
    executionHandle: admission.executionHandle,
    checkUri,
    recordedAt: observedAt,
    facts: [{
      kind: capability,
      observedAt,
      values: { "result status": "accepted" },
    }],
  });

  const malformed = await postTrace(runtime.endpoint, {}, true);
  assert.equal(malformed.status, 400, "malformed OTLP remains a transport-contract error");

  const unauthorized = await postTrace(runtime.endpoint, incompleteTrace, false);
  assert.equal(unauthorized.status, 401, "a syntactically valid trace still requires both identities");

  const emptyTrace = otlpTrace({
    attemptKey,
    executionHandle: admission.executionHandle,
    checkUri,
    recordedAt: observedAt,
    facts: [],
  });
  const emptyRejected = await postTrace(runtime.endpoint, emptyTrace, true);
  assert.equal(emptyRejected.status, 200, "an empty observation is a semantic rejection");
  assert.deepEqual(await emptyRejected.json(), {
    partialSuccess: {
      rejectedSpans: 1,
      errorMessage: "fact-batch-rejected",
    },
  });

  const rejected = await postTrace(runtime.endpoint, incompleteTrace, true);
  assert.equal(rejected.status, 200, "a semantic Fact rejection uses the OTLP success envelope");
  assert.deepEqual(await rejected.json(), {
    partialSuccess: {
      rejectedSpans: 1,
      errorMessage: "fact-batch-rejected",
    },
  });

  const missingCoordinate = otlpTrace({
    attemptKey,
    executionHandle: admission.executionHandle,
    checkUri,
    recordedAt: observedAt,
    facts: [{
      kind: capability,
      observedAt,
      values: {
        "tested project": ["project-a", "project-b"],
        "tested revision": [
          {
            value: "revision-a",
            parents: [],
          },
          correlatedObservation("revision-b", "project-b"),
        ],
        "result status": "accepted",
        "qualification token": "token-one",
      },
    }],
  });
  const missingCoordinateRejected = await postTrace(runtime.endpoint, missingCoordinate, true);
  assert.deepEqual(await missingCoordinateRejected.json(), {
    partialSuccess: { rejectedSpans: 1, errorMessage: "fact-batch-rejected" },
  });

  const invalidParentCoordinates = [
    {
      label: "extra",
      parents: [
        { kind: "observation", port: "tested project", value: "project-a" },
        { kind: "input", port: "candidate project", value: "project-a" },
      ],
    },
    {
      label: "duplicate",
      parents: [
        { kind: "observation", port: "tested project", value: "project-a" },
        { kind: "observation", port: "tested project", value: "project-a" },
      ],
    },
  ] as const;
  for (const invalid of invalidParentCoordinates) {
    const invalidTrace = otlpTrace({
      attemptKey,
      executionHandle: admission.executionHandle,
      checkUri,
      recordedAt: observedAt,
      facts: [{
        kind: capability,
        observedAt,
        values: {
          "tested project": ["project-a", "project-b"],
          "tested revision": [
            { value: "revision-a", parents: invalid.parents },
            correlatedObservation("revision-b", "project-b"),
          ],
          "result status": "accepted",
          "qualification token": "token-one",
        },
      }],
    });
    const invalidRejected = await postTrace(runtime.endpoint, invalidTrace, true);
    assert.deepEqual(
      await invalidRejected.json(),
      { partialSuccess: { rejectedSpans: 1, errorMessage: "fact-batch-rejected" } },
      `${invalid.label} parent coordinates are rejected atomically`,
    );
  }

  const missingReportObservation = otlpTrace({
    attemptKey,
    executionHandle: admission.executionHandle,
    checkUri,
    recordedAt: observedAt,
    facts: [{
      kind: capability,
      observedAt,
      values: {
        "tested project": ["project-a", "project-b"],
        "tested revision": [
          correlatedObservation("revision-a", "project-a"),
          correlatedObservation("revision-b", "project-b"),
        ],
        "result status": "accepted",
      },
    }],
  });
  const missingReportObservationRejected = await postTrace(
    runtime.endpoint,
    missingReportObservation,
    true,
  );
  assert.deepEqual(await missingReportObservationRejected.json(), {
    partialSuccess: { rejectedSpans: 1, errorMessage: "fact-batch-rejected" },
  });

  const wrongCapability = otlpTrace({
    attemptKey,
    executionHandle: admission.executionHandle,
    checkUri,
    recordedAt: observedAt,
    facts: [{
      kind: "acceptance.other-capability",
      observedAt,
      values: {
        "tested project": ["project-a", "project-b"],
        "tested revision": [
          correlatedObservation("revision-a", "project-a"),
          correlatedObservation("revision-b", "project-b"),
        ],
        "result status": "accepted",
      },
    }],
  });
  const wrongCapabilityRejected = await postTrace(runtime.endpoint, wrongCapability, true);
  assert.deepEqual(await wrongCapabilityRejected.json(), {
    partialSuccess: { rejectedSpans: 1, errorMessage: "fact-batch-rejected" },
  });

  const missingFacts = await rejectedRpc(runtime.endpoint, "skill.attempt.finalize", {
    contract: "trust.skill-finalization-request@1",
    executionHandle: admission.executionHandle,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  assert.equal(missingFacts.reason, "facts-missing");
  assert.deepEqual(await readCheck(runtime.endpoint, checkUri), {
    contract: "trust.check-view@1",
    checkUri,
    state: "OPEN",
    history: [],
  });

  const crossedTrace = otlpTrace({
    attemptKey,
    executionHandle: admission.executionHandle,
    checkUri,
    recordedAt: observedAt,
    facts: [{
      kind: capability,
      observedAt,
      values: {
        "result status": "accepted",
        "qualification token": "token-one",
        "tested project": ["project-b", "project-a"],
        "tested revision": [
          correlatedObservation("revision-b", "project-a"),
          correlatedObservation("revision-a", "project-b"),
        ],
      },
    }],
  });
  const crossedAccepted = await postTrace(runtime.endpoint, crossedTrace, true);
  assert.equal(crossedAccepted.status, 200);
  assert.deepEqual(await crossedAccepted.json(), {});

  const crossedFinalized = await rpc<{
    readonly verdict: string;
    readonly reasonCode: string;
    readonly reason: string;
    readonly checklistDelta: { readonly newlySatisfied: readonly string[] };
  }>(runtime.endpoint, "skill.attempt.finalize", {
    contract: "trust.skill-finalization-request@1",
    executionHandle: admission.executionHandle,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  assert.equal(crossedFinalized.verdict, "NOT_VALIDATED");
  assert.equal(crossedFinalized.reasonCode, "qualification-predicate-failed");
  assert.equal(crossedFinalized.reason, "a project was tested at another revision");
  assert.deepEqual(crossedFinalized.checklistDelta.newlySatisfied, []);
  assert.equal((await readCheck(runtime.endpoint, checkUri)).state, "OPEN");
  const failedCheckFeedback = await callMcpText(mcp, "trust_check_read", { checkUri });
  assert.match(failedCheckFeedback, /^Status: OPEN$/m);
  assert.match(failedCheckFeedback, /^Active qualification: none$/m);
  assert.match(failedCheckFeedback, /^Latest accepted attempt verdict: NOT_VALIDATED$/m);
  assert.match(
    failedCheckFeedback,
    /^Latest accepted attempt reason code: qualification-predicate-failed$/m,
  );
  assert.match(
    failedCheckFeedback,
    /^Latest accepted attempt reason: a project was tested at another revision$/m,
  );
  assert.match(failedCheckFeedback, /^Accepted attempt history: 1$/m);
  assert.match(failedCheckFeedback, /^Attempt 1:$/m);
  assert.match(failedCheckFeedback, /^  Verdict: NOT_VALIDATED$/m);
  assert.match(failedCheckFeedback, /^  Reason code: qualification-predicate-failed$/m);
  const failedPlanFeedback = await callMcpText(mcp, "trust_plan_read", { checkUri });
  assert.match(failedPlanFeedback, /^Latest current-Check attempt verdict: NOT_VALIDATED$/m);
  assert.match(
    failedPlanFeedback,
    /^Latest current-Check attempt reason code: qualification-predicate-failed$/m,
  );
  assert.match(failedPlanFeedback, /^Latest attempt newly satisfied Checks: 0$/m);
  assert.match(failedPlanFeedback, /^Latest attempt newly opened Checks: 0$/m);
  const stillBlockedConsumer = await callMcpText(mcp, "trust_check_read", {
    checkUri: consumerCheckUri,
  });
  assert.match(stillBlockedConsumer, /^Actionable: no$/m);
  assert.match(
    stillBlockedConsumer,
    new RegExp(`^Blocked by: \\["${escapeRegExp(checkUri)}"\\]$`, "m"),
  );

  const collectionMismatches = [
    {
      label: "missing",
      projects: ["project-a"],
      revisions: [correlatedObservation("revision-a", "project-a")],
    },
    {
      label: "extra",
      projects: ["project-a", "project-b", "project-c"],
      revisions: [
        correlatedObservation("revision-a", "project-a"),
        correlatedObservation("revision-b", "project-b"),
        correlatedObservation("revision-c", "project-c"),
      ],
    },
    {
      label: "duplicate",
      projects: ["project-a", "project-a", "project-b"],
      revisions: [
        correlatedObservation("revision-a", "project-a"),
        correlatedObservation("revision-b", "project-b"),
      ],
    },
  ] as const;
  for (const mismatch of collectionMismatches) {
    const attempt = await admitQualificationAttempt(
      runtime.endpoint,
      checkUri,
      `required-observations-${mismatch.label}`,
    );
    const mismatchAt = new Date().toISOString();
    const accepted = await postTrace(runtime.endpoint, otlpTrace({
      attemptKey: attempt.attemptKey,
      executionHandle: attempt.executionHandle,
      checkUri,
      recordedAt: mismatchAt,
      facts: [{
        kind: capability,
        observedAt: mismatchAt,
        values: {
          "result status": "accepted",
          "qualification token": "token-one",
          "tested project": mismatch.projects,
          "tested revision": mismatch.revisions,
        },
      }],
    }), true);
    assert.deepEqual(
      await accepted.json(),
      {},
      `${mismatch.label} collection remains a valid complete Fact batch`,
    );
    const result = await rpc<{
      readonly verdict: string;
      readonly checklistDelta: { readonly newlySatisfied: readonly string[] };
    }>(runtime.endpoint, "skill.attempt.finalize", {
      contract: "trust.skill-finalization-request@1",
      executionHandle: attempt.executionHandle,
    }, {
      authorization: credentials.runtime,
      processAuthorization: credentials.process,
    });
    assert.equal(result.verdict, "NOT_VALIDATED", mismatch.label);
    assert.deepEqual(result.checklistDelta.newlySatisfied, [], mismatch.label);
    assert.equal((await readCheck(runtime.endpoint, checkUri)).state, "OPEN", mismatch.label);
  }

  const correctAttemptKey = "required-observations-attempt-2";
  const correctAdmission = await rpc<{
    readonly status: string;
    readonly executionHandle: string;
  }>(runtime.endpoint, "skill.attempt.admit", {
    contract: "trust.skill-admission-request@1",
    attemptKey: correctAttemptKey,
    checkUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli",
    runtimeIdentity,
    processIdentity,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  assert.equal(correctAdmission.status, "ADMITTED");
  const correctObservedAt = new Date(Date.now() + 1).toISOString();
  const correctTrace = otlpTrace({
    attemptKey: correctAttemptKey,
    executionHandle: correctAdmission.executionHandle,
    checkUri,
    recordedAt: correctObservedAt,
    facts: [{
      kind: capability,
      observedAt: correctObservedAt,
      values: {
        "result status": "accepted",
        "qualification token": "token-one",
        "tested project": ["project-b", "project-a"],
        "tested revision": [
          correlatedObservation("revision-b", "project-b"),
          correlatedObservation("revision-a", "project-a"),
        ],
      },
    }],
  });
  const correctAccepted = await postTrace(runtime.endpoint, correctTrace, true);
  assert.deepEqual(await correctAccepted.json(), {});
  const finalized = await rpc<{
    readonly verdict: string;
    readonly checklistDelta: {
      readonly newlySatisfied: readonly string[];
      readonly newlyOpened: readonly string[];
    };
  }>(runtime.endpoint, "skill.attempt.finalize", {
    contract: "trust.skill-finalization-request@1",
    executionHandle: correctAdmission.executionHandle,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  assert.equal(finalized.verdict, "VALIDATED");
  assert.deepEqual(finalized.checklistDelta.newlySatisfied, [checkUri]);
  assert.equal(finalized.checklistDelta.newlyOpened.length, 1);
  assert.deepEqual(finalized.checklistDelta.newlyOpened, [consumerCheckUri]);
  const finalCheck = await readCheck(runtime.endpoint, checkUri);
  assert.equal(finalCheck.state, "SATISFIED");
  assert.equal(finalCheck.history.length, 5);
  const qualifiedCheckFeedback = await callMcpText(mcp, "trust_check_read", { checkUri });
  assert.match(qualifiedCheckFeedback, /^Status: SATISFIED$/m);
  assert.match(qualifiedCheckFeedback, /^Active qualification: VALIDATED$/m);
  assert.match(qualifiedCheckFeedback, /^Latest accepted attempt verdict: VALIDATED$/m);
  assert.match(qualifiedCheckFeedback, /^Latest accepted attempt reason code: check-qualified$/m);
  assert.match(qualifiedCheckFeedback, /^Accepted attempt history: 5$/m);
  assert.match(qualifiedCheckFeedback, /^Attempt 5:$/m);
  const actionableConsumer = await callMcpText(mcp, "trust_check_read", {
    checkUri: consumerCheckUri,
  });
  assert.match(actionableConsumer, /^Status: OPEN$/m);
  assert.match(actionableConsumer, /^Actionable: yes$/m);
  assert.match(actionableConsumer, /^Blocked by: none$/m);

  const staleConsumerAdmission = await rpc<{
    readonly status: string;
    readonly executionHandle: string;
  }>(runtime.endpoint, "skill.attempt.admit", {
    contract: "trust.skill-admission-request@1",
    attemptKey: "report-consumer-stale",
    checkUri: consumerCheckUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli",
    runtimeIdentity,
    processIdentity,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  assert.equal(staleConsumerAdmission.status, "ADMITTED");

  const revisedProviderAdmission = await rpc<{
    readonly status: string;
    readonly executionHandle: string;
  }>(runtime.endpoint, "skill.attempt.admit", {
    contract: "trust.skill-admission-request@1",
    attemptKey: "required-observations-attempt-3",
    checkUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli",
    runtimeIdentity,
    processIdentity,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  const revisedAt = new Date(Date.now() + 2).toISOString();
  assert.deepEqual(await (await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "required-observations-attempt-3",
    executionHandle: revisedProviderAdmission.executionHandle,
    checkUri,
    recordedAt: revisedAt,
    facts: [{
      kind: capability,
      observedAt: revisedAt,
      values: {
        "result status": "accepted",
        "qualification token": "token-two",
        "tested project": ["project-a", "project-b"],
        "tested revision": [
          correlatedObservation("revision-a", "project-a"),
          correlatedObservation("revision-b", "project-b"),
        ],
      },
    }],
  }), true)).json(), {});
  const revisedProvider = await rpc<{
    readonly verdict: string;
    readonly checklistDelta: { readonly newlyOpened: readonly string[] };
  }>(runtime.endpoint, "skill.attempt.finalize", {
    contract: "trust.skill-finalization-request@1",
    executionHandle: revisedProviderAdmission.executionHandle,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  assert.equal(revisedProvider.verdict, "VALIDATED");
  assert.equal((await readCheck(runtime.endpoint, consumerCheckUri)).state, "OPEN");

  const staleAt = new Date(Date.now() + 3).toISOString();
  const staleReportRejected = await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "report-consumer-stale",
    executionHandle: staleConsumerAdmission.executionHandle,
    checkUri: consumerCheckUri,
    recordedAt: staleAt,
    facts: [{
      kind: consumerCapability,
      observedAt: staleAt,
      values: { "observed token": "token-one" },
    }],
  }), true);
  assert.deepEqual(await staleReportRejected.json(), {
    partialSuccess: { rejectedSpans: 1, errorMessage: "fact-batch-rejected" },
  });

  const freshConsumerAdmission = await rpc<{
    readonly status: string;
    readonly executionHandle: string;
  }>(runtime.endpoint, "skill.attempt.admit", {
    contract: "trust.skill-admission-request@1",
    attemptKey: "report-consumer-fresh",
    checkUri: consumerCheckUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli",
    runtimeIdentity,
    processIdentity,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  const freshAt = new Date(Date.now() + 4).toISOString();
  assert.deepEqual(await (await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "report-consumer-fresh",
    executionHandle: freshConsumerAdmission.executionHandle,
    checkUri: consumerCheckUri,
    recordedAt: freshAt,
    facts: [{
      kind: consumerCapability,
      observedAt: freshAt,
      values: { "observed token": "token-two" },
    }],
  }), true)).json(), {});
  const freshConsumer = await rpc<{ readonly verdict: string }>(
    runtime.endpoint,
    "skill.attempt.finalize",
    {
      contract: "trust.skill-finalization-request@1",
      executionHandle: freshConsumerAdmission.executionHandle,
    },
    {
      authorization: credentials.runtime,
      processAuthorization: credentials.process,
    },
  );
  assert.equal(freshConsumer.verdict, "VALIDATED");
  assert.equal((await readCheck(runtime.endpoint, consumerCheckUri)).state, "SATISFIED");

  const sameReportStaleAdmission = await rpc<{
    readonly status: string;
    readonly executionHandle: string;
  }>(runtime.endpoint, "skill.attempt.admit", {
    contract: "trust.skill-admission-request@1",
    attemptKey: "report-consumer-same-report-stale",
    checkUri: consumerCheckUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli",
    runtimeIdentity,
    processIdentity,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  const invalidProviderAdmission = await rpc<{
    readonly status: string;
    readonly executionHandle: string;
  }>(runtime.endpoint, "skill.attempt.admit", {
    contract: "trust.skill-admission-request@1",
    attemptKey: "required-observations-attempt-4",
    checkUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli",
    runtimeIdentity,
    processIdentity,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  const invalidAt = new Date(Date.now() + 5).toISOString();
  assert.deepEqual(await (await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "required-observations-attempt-4",
    executionHandle: invalidProviderAdmission.executionHandle,
    checkUri,
    recordedAt: invalidAt,
    facts: [{
      kind: capability,
      observedAt: invalidAt,
      values: {
        "result status": "accepted",
        "qualification token": "token-two",
        "tested project": ["project-a", "project-b"],
        "tested revision": [
          correlatedObservation("revision-b", "project-a"),
          correlatedObservation("revision-a", "project-b"),
        ],
      },
    }],
  }), true)).json(), {});
  const invalidProvider = await rpc<{ readonly verdict: string }>(
    runtime.endpoint,
    "skill.attempt.finalize",
    {
      contract: "trust.skill-finalization-request@1",
      executionHandle: invalidProviderAdmission.executionHandle,
    },
    {
      authorization: credentials.runtime,
      processAuthorization: credentials.process,
    },
  );
  assert.equal(invalidProvider.verdict, "NOT_VALIDATED");
  assert.equal((await readCheck(runtime.endpoint, checkUri)).state, "OPEN");
  assert.equal((await readCheck(runtime.endpoint, consumerCheckUri)).state, "OPEN");

  const sameReportAt = new Date(Date.now() + 6).toISOString();
  const sameReportStaleRejected = await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "report-consumer-same-report-stale",
    executionHandle: sameReportStaleAdmission.executionHandle,
    checkUri: consumerCheckUri,
    recordedAt: sameReportAt,
    facts: [{
      kind: consumerCapability,
      observedAt: sameReportAt,
      values: { "observed token": "token-two" },
    }],
  }), true);
  assert.deepEqual(await sameReportStaleRejected.json(), {
    partialSuccess: { rejectedSpans: 1, errorMessage: "fact-batch-rejected" },
  });
});

function correlatedObservation(revision: string, project: string) {
  return {
    value: revision,
    parents: [{ kind: "observation", port: "tested project", value: project }],
  } as const;
}

async function admitQualificationAttempt(
  endpoint: string,
  checkUri: string,
  attemptKey: string,
): Promise<{ readonly attemptKey: string; readonly executionHandle: string }> {
  const admission = await rpc<{
    readonly status: string;
    readonly executionHandle: string;
  }>(endpoint, "skill.attempt.admit", {
    contract: "trust.skill-admission-request@1",
    attemptKey,
    checkUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli",
    runtimeIdentity,
    processIdentity,
  }, {
    authorization: credentials.runtime,
    processAuthorization: credentials.process,
  });
  assert.equal(admission.status, "ADMITTED");
  return { attemptKey, executionHandle: admission.executionHandle };
}

interface TraceInput {
  readonly attemptKey: string;
  readonly executionHandle: string;
  readonly checkUri: string;
  readonly facts: readonly Readonly<Record<string, unknown>>[];
  readonly recordedAt: string;
}

function otlpTrace(input: TraceInput): Readonly<Record<string, unknown>> {
  const timeUnixNano = (BigInt(Date.parse(input.recordedAt)) * 1_000_000n).toString();
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
          events: input.facts.map((fact, index) => ({
            name: "trust.skill.fact",
            attributes: otlpFactAttributes(fact, index),
          })),
        }],
      }],
    }],
  };
}

function stringAttribute(key: string, value: string): Readonly<Record<string, unknown>> {
  return { key, value: { stringValue: value } };
}

async function postTrace(
  endpoint: string,
  body: unknown,
  authenticated: boolean,
): Promise<Response> {
  return fetch(`${endpoint}/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(authenticated
        ? {
            authorization: `Bearer ${credentials.runtime}`,
            "x-trust-process-authorization": `Bearer ${credentials.process}`,
          }
        : {}),
    },
    body: JSON.stringify(body),
    redirect: "error",
  });
}

async function readCheck(endpoint: string, checkUri: string): Promise<{
  readonly contract: string;
  readonly checkUri: string;
  readonly state: string;
  readonly history: readonly unknown[];
}> {
  return rpc(endpoint, "check.read", {
    contract: "trust.check-read-request@1",
    checkUri,
  }, { authorization: credentials.observer });
}

interface RpcAuthorization {
  readonly authorization?: string;
  readonly processAuthorization?: string;
}

async function rpc<Result = unknown>(
  endpoint: string,
  method: string,
  params: unknown,
  authorization: RpcAuthorization = {},
): Promise<Result> {
  const envelope = await rpcEnvelope(endpoint, method, params, authorization);
  if ("error" in envelope) {
    assert.fail(`unexpected ${method} error: ${JSON.stringify(envelope.error)}`);
  }
  return envelope.result as Result;
}

async function rejectedRpc(
  endpoint: string,
  method: string,
  params: unknown,
  authorization: RpcAuthorization,
): Promise<{ readonly reason: string }> {
  const envelope = await rpcEnvelope(endpoint, method, params, authorization);
  assert.ok("error" in envelope, `${method} must be rejected`);
  assert.equal(typeof envelope.error.data, "object");
  assert.notEqual(envelope.error.data, null);
  return envelope.error.data as { readonly reason: string };
}

async function rpcEnvelope(
  endpoint: string,
  method: string,
  params: unknown,
  authorization: RpcAuthorization,
): Promise<
  | { readonly result: unknown }
  | { readonly error: { readonly data?: unknown } }
> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(authorization.authorization === undefined
        ? {}
        : { authorization: `Bearer ${authorization.authorization}` }),
      ...(authorization.processAuthorization === undefined
        ? {}
        : {
            "x-trust-process-authorization":
              `Bearer ${authorization.processAuthorization}`,
          }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    redirect: "error",
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<
    | { readonly result: unknown }
    | { readonly error: { readonly data?: unknown } }
  >;
}

interface McpClient {
  readonly endpoint: string;
  readonly credential: string;
  readonly protocolVersion: string;
  readonly sessionId?: string;
  nextId: number;
}

async function initializeMcp(endpoint: string, credential: string): Promise<McpClient> {
  const protocolVersion = "2025-11-25";
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "fact-ingestion-acceptance", version: "1.0.0" },
      },
    }),
  });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id") ?? undefined;
  await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${credential}`,
      "mcp-protocol-version": protocolVersion,
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return {
    endpoint,
    credential,
    protocolVersion,
    ...(sessionId === undefined ? {} : { sessionId }),
    nextId: 0,
  };
}

async function callMcpText(
  client: McpClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const id = `fact-ingestion-mcp-${++client.nextId}`;
  const response = await fetch(`${client.endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${client.credential}`,
      "mcp-protocol-version": client.protocolVersion,
      ...(client.sessionId === undefined ? {} : { "mcp-session-id": client.sessionId }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json() as {
    readonly id: string;
    readonly result?: {
      readonly isError?: boolean;
      readonly content: readonly { readonly type: string; readonly text: string }[];
    };
    readonly error?: unknown;
  };
  assert.equal(envelope.id, id);
  assert.equal(envelope.error, undefined);
  assert.equal(envelope.result?.isError, undefined);
  assert.deepEqual(envelope.result?.content.map(({ type }) => type), ["text"]);
  const text = envelope.result?.content[0]?.text;
  if (text === undefined) assert.fail(`${name} must return one text result`);
  return text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    credentialSha256:
      `sha256:${createHash("sha256").update(credential, "utf8").digest("hex")}`,
    ...(publicKey === undefined ? {} : { publicKey }),
  };
}

function signRegistryRecord<RecordValue extends Readonly<Record<string, unknown>>>(
  record: RecordValue,
  privateKey: KeyObject,
): RecordValue & { readonly signature: string } {
  return {
    ...record,
    signature: sign(
      null,
      Buffer.from(canonicalJson(record), "utf8"),
      privateKey,
    ).toString("base64"),
  };
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
