import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { otlpFactAttributes } from "./support/otlp-fact.js";
import { startPublicRuntime } from "./support/runtime-process.js";

const leftDiscover = "stability.discover-left";
const rightDiscover = "stability.discover-right";
const leftUse = "stability.use-left";
const leftPublish = "stability.publish-left";
const rightUse = "stability.use-right";
const capabilities = [leftDiscover, rightDiscover, leftUse, leftPublish, rightUse] as const;

const environment = "progression-stability-test";
const deploymentKey = "progression-stability-skill";
const releaseDigest = `sha256:${"d".repeat(64)}`;
const distributionDigest = `sha256:${"e".repeat(64)}`;
const publisherIdentity = "spiffe://acceptance.example/skill-publishers/progression-stability";
const distributionVerifierIdentity =
  "spiffe://acceptance.example/distribution-verifiers/progression-stability";
const operatorIdentity = "spiffe://acceptance.example/operators/progression-stability";
const observerIdentity = "spiffe://acceptance.example/observers/progression-stability";
const runtimeIdentity = "spiffe://acceptance.example/skill-runtimes/progression-stability";
const processIdentity = "urn:uuid:00000000-0000-4000-8000-0000000000a1";

const credentials = {
  publisher: "progression_stability_publisher_credential",
  distributionVerifier: "progression_stability_distribution_verifier_credential",
  operator: "progression_stability_operator_credential",
  observer: "progression_stability_observer_credential",
  runtime: "progression_stability_runtime_credential",
  process: "progression_stability_process_credential",
} as const;

const distributionVerifierKeys = generateKeyPairSync("ed25519");
const procedureSource = `# language: en
@trust-dsl:1 @procedure:progression-stability @version:1.0.0
Feature: Preserve admitted Checks while independent discoveries progress the Plan
  Two independent discoveries may be running from the same revision. Each validated output
  materializes its own downstream Check without invalidating the other historical attempt.

  Background: Procedure interface
${capabilityDeclaration({
  capability: leftDiscover,
  inputs: [{ port: "workspace", cardinality: "one" }],
  observations: [
    { name: "left count", type: "number", cardinality: "one", domain: "any" },
    { name: "left item", type: "reference", cardinality: "one", domain: "any" },
  ],
  output: { name: "left item", observation: "left item", parentInput: "workspace" },
})}
${capabilityDeclaration({
  capability: rightDiscover,
  inputs: [{ port: "workspace", cardinality: "one" }],
  observations: [
    { name: "right count", type: "number", cardinality: "one", domain: "any" },
    { name: "right item", type: "reference", cardinality: "many", domain: "any" },
  ],
  output: { name: "right item", observation: "right item", parentInput: "workspace" },
})}
${capabilityDeclaration({
  capability: leftUse,
  inputs: [
    { port: "workspace", cardinality: "one" },
    { port: "left item", cardinality: "one" },
  ],
  observations: [{
    name: "left status",
    type: "string",
    cardinality: "one",
    domain: 'enum "used", "not-used"',
  }],
})}
${capabilityDeclaration({
  capability: leftPublish,
  inputs: [
    { port: "workspace", cardinality: "one" },
    { port: "left item", cardinality: "one" },
  ],
  observations: [{
    name: "publication status",
    type: "string",
    cardinality: "one",
    domain: 'enum "published", "not-published"',
  }],
})}
${capabilityDeclaration({
  capability: rightUse,
  inputs: [{ port: "right item", cardinality: "one" }],
  observations: [{
    name: "right status",
    type: "string",
    cardinality: "one",
    domain: 'enum "used", "not-used"',
  }],
})}
    Given one "workspace"
    And one "left item" for "workspace"
    And many "right item" for "workspace"

  @scenario:left-discovery
  Scenario: Discover the left-side items
    Then Check "left discovery" uses Skill capability "stability.discover-left" on "workspace" as input "workspace" and materializes "left item" from output "left item" and must establish "left-side items are known"
      | observation | relation | expectation | failure feedback                  |
      | left count  | at least | number 1    | "no left-side item was observed" |
    And the scenario is verified when all Skill actions are validated

  @scenario:right-discovery
  Scenario: Discover the right-side items
    Then Check "right discovery" uses Skill capability "stability.discover-right" on "workspace" as input "workspace" and materializes "right item" from output "right item" and must establish "right-side items are known"
      | observation | relation | expectation | failure feedback                   |
      | right count | at least | number 1    | "no right-side item was observed" |
    And the scenario is verified when all Skill actions are validated

  @scenario:left-use
  Scenario: Use every discovered left-side item
    Given scenario "left-discovery" is validated
    Then Check "left usage" uses Skill capability "stability.use-left" on "workspace" as input "workspace" using "left item" as input "left item" and must establish "the current left-side item was used"
      | observation | relation | expectation | failure feedback                  |
      | left status | equals   | literal "used" | "the left-side item was not used" |
    And the scenario is verified when all Skill actions are validated

  @scenario:right-use
  Scenario: Use every discovered right-side item
    Given scenario "right-discovery" is validated
    Then Check "right usage" uses Skill capability "stability.use-right" on each "right item" as input "right item" and must establish "the right-side item was used"
      | observation  | relation | expectation | failure feedback                   |
      | right status | equals   | literal "used" | "the right-side item was not used" |
    And the scenario is verified when all Skill actions are validated

  @scenario:left-publication
  Scenario: Publish the verified current left-side item
    Given scenario "left-use" is validated
    Then Check "left publication" uses Skill capability "stability.publish-left" on "workspace" as input "workspace" using "left item" as input "left item" and must establish "the current left-side item was published"
      | observation        | relation | expectation | failure feedback                       |
      | publication status | equals   | literal "published" | "the left-side item was not published" |
    And the scenario is verified when all Skill actions are validated
`;

function capabilityDeclaration(input: {
  readonly capability: string;
  readonly inputs: readonly {
    readonly port: string;
    readonly cardinality: "one" | "many";
  }[];
  readonly observations: readonly {
    readonly name: string;
    readonly type: "string" | "number" | "reference";
    readonly cardinality: "one" | "many";
    readonly domain: string;
  }[];
  readonly output?: {
    readonly name: string;
    readonly observation: string;
    readonly parentInput: string;
  };
}): string {
  const lines = [
    `    Given Skill capability "${input.capability}" performs read and is replayable`,
    `    And Skill capability "${input.capability}" accepts`,
    "      | input | type | cardinality |",
    ...input.inputs.map((item) => `      | ${item.port} | reference | ${item.cardinality} |`),
    `    And Skill capability "${input.capability}" reports`,
    "      | observation | type | cardinality | domain |",
    ...input.observations.map((item) =>
      `      | ${item.name} | ${item.type} | ${item.cardinality} | ${item.domain} |`
    ),
    input.output === undefined
      ? `    And Skill capability "${input.capability}" exposes no outputs`
      : [
          `    And Skill capability "${input.capability}" exposes outputs`,
          "      | output | from observation | parents |",
          `      | ${input.output.name} | ${input.output.observation} | input "${input.output.parentInput}" |`,
        ].join("\n"),
  ];
  return lines.join("\n");
}

test("historical admissions survive progressive revisions and exact replay is idempotent", {
  timeout: 30_000,
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-progression-stability-db-"));
  const databasePath = path.join(directory, "trust.sqlite");
  const runtimeOptions = {
    databasePath,
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
  } as const;
  let runtime = await startPublicRuntime("trust-progression-stability-", runtimeOptions);
  context.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  const published = await rpc<{
    readonly definition: {
      readonly requiredCapabilities: readonly CapabilityRequirement[];
    };
  }>(runtime.endpoint, "procedure.definition.publish", {
    source: procedureSource,
    sourceName: "progression-stability.feature",
  }, auth(credentials.publisher));
  const requirements = new Map(
    published.definition.requiredCapabilities.map((item) => [item.capability, item]),
  );

  await rpc(runtime.endpoint, "skill.release.claim", {
    release: {
      contract: "trust.skill-release@1",
      skill: "trust.progression-stability",
      version: "1.0.0",
      releaseDigest,
      publisher: publisherIdentity,
      implements: capabilities.map((capability) => ({
        capability,
        actionContractDigest: requiredRequirement(requirements, capability).actionContractDigest,
      })),
      entrypoints: { cli: "bin/trust-progression-stability" },
      probes: ["runtime-ready"],
    },
  }, auth(credentials.publisher));
  const distribution = {
    contract: "trust.verified-skill-distribution@1",
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
  }, auth(credentials.distributionVerifier));

  await rpc(runtime.endpoint, "skill.release.authorization.set", {
    environment,
    releaseDigest,
    decision: "ALLOW",
  }, auth(credentials.operator));
  await rpc(runtime.endpoint, "skill.deployment.authorization.set", {
    environment,
    deploymentKey,
    releaseDigest,
    envelope: "cli",
    runtimeIdentity,
    decision: "ALLOW",
  }, auth(credentials.operator));
  for (const capability of capabilities) {
    const requirement = requiredRequirement(requirements, capability);
    await rpc(runtime.endpoint, "skill.deployment.selection.set", {
      environment,
      requirement: {
        capability,
        actionContractDigest: requirement.actionContractDigest,
      },
      deploymentKey,
    }, auth(credentials.operator));
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
  }, auth(credentials.runtime, credentials.process));

  const engagementRequest = {
    contract: "trust.plan-engagement-request@1",
    procedure: "progression-stability",
    procedureVersion: "1.0.0",
    plan: "stability-plan",
    environment,
    rootInputs: { workspace: "workspace-42" },
  };
  const revisionOne = await rpc<PlanEngagement>(
    runtime.endpoint,
    "plan.engage",
    engagementRequest,
    auth(credentials.operator),
  );
  assert.equal(revisionOne.revision, 1);
  assert.equal(revisionOne.checkUris.length, 2);
  const leftCheckUri = uriFor(revisionOne.checkUris, "/left-discovery/");
  const rightCheckUri = uriFor(revisionOne.checkUris, "/right-discovery/");

  // Both immutable grants are resolved against revision N before either one completes.
  const leftAdmission = await admit(runtime.endpoint, "left-attempt-n", leftCheckUri);
  const rightAdmission = await admit(runtime.endpoint, "right-attempt-n", rightCheckUri);
  const rightReplayAdmission = await admit(
    runtime.endpoint,
    "right-attempt-n-replay",
    rightCheckUri,
  );
  assert.equal(leftAdmission.status, "ADMITTED");
  assert.equal(rightAdmission.status, "ADMITTED");
  assert.equal(rightReplayAdmission.status, "ADMITTED");

  const observedAt = new Date().toISOString();
  const leftTrace = otlpTrace({
    attemptKey: "left-attempt-n",
    executionHandle: leftAdmission.executionHandle,
    checkUri: leftCheckUri,
    recordedAt: observedAt,
    fact: {
      kind: leftDiscover,
      observedAt,
      values: { "left count": 1, "left item": "left-1" },
      outputs: [{
        output: "left item",
        value: "left-1",
        parents: [{ kind: "input", port: "workspace", value: "workspace-42" }],
      }],
    },
  });
  assert.deepEqual(await postTrace(runtime.endpoint, leftTrace), {});
  const leftFinalized = await finalize(runtime.endpoint, leftAdmission.executionHandle);
  assert.equal(leftFinalized.verdict, "VALIDATED");
  assert.deepEqual(leftFinalized.checklistDelta.newlySatisfied, [leftCheckUri]);
  assert.equal(leftFinalized.checklistDelta.newlyOpened.length, 1);
  const leftUseUri = uriFor(leftFinalized.checklistDelta.newlyOpened, "/left-use/");

  const revisionTwo = await rpc<PlanEngagement>(
    runtime.endpoint,
    "plan.engage",
    engagementRequest,
    auth(credentials.operator),
  );
  assert.equal(revisionTwo.revision, 2, "finalizing A must derive N+1");
  assert.ok(revisionTwo.checkUris.includes(leftUseUri));

  const rightTrace = otlpTrace({
    attemptKey: "right-attempt-n",
    executionHandle: rightAdmission.executionHandle,
    checkUri: rightCheckUri,
    recordedAt: observedAt,
    fact: {
      kind: rightDiscover,
      observedAt,
      values: { "right count": 2, "right item": ["right-1", "right-2"] },
      outputs: ["right-1", "right-2"].map((value) => ({
        output: "right item",
        value,
        parents: [{ kind: "input", port: "workspace", value: "workspace-42" }],
      })),
    },
  });
  assert.deepEqual(await postTrace(runtime.endpoint, rightTrace), {});
  const rightFinalized = await finalize(runtime.endpoint, rightAdmission.executionHandle);
  assert.equal(rightFinalized.verdict, "VALIDATED");
  assert.deepEqual(rightFinalized.checklistDelta.newlySatisfied, [rightCheckUri]);
  assert.equal(rightFinalized.checklistDelta.newlyOpened.length, 2);
  const rightUseUris = rightFinalized.checklistDelta.newlyOpened
    .filter((uri) => uri.includes("/right-use/"))
    .sort();
  assert.equal(rightUseUris.length, 2);
  const rightUseUri = uriFor(rightUseUris, "/right-1");
  const removedRightUseUri = uriFor(rightUseUris, "/right-2");

  const revisionThree = await rpc<PlanEngagement>(
    runtime.endpoint,
    "plan.engage",
    engagementRequest,
    auth(credentials.operator),
  );
  assert.equal(
    revisionThree.revision,
    3,
    "finalizing historical B admitted on N must derive N+2 from current state",
  );
  assert.ok(revisionThree.checkUris.includes(leftUseUri));
  assert.ok(revisionThree.checkUris.includes(rightUseUri));

  const leftUseAdmission = await admit(runtime.endpoint, "left-use-attempt-one", leftUseUri);
  assert.equal(leftUseAdmission.status, "ADMITTED");
  const leftUseObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "left-use-attempt-one",
    executionHandle: leftUseAdmission.executionHandle,
    checkUri: leftUseUri,
    recordedAt: leftUseObservedAt,
    fact: {
      kind: leftUse,
      observedAt: leftUseObservedAt,
      values: { "left status": "used" },
    },
  })), {});
  const leftUseFinalized = await finalize(runtime.endpoint, leftUseAdmission.executionHandle);
  assert.equal(leftUseFinalized.verdict, "VALIDATED");
  assert.equal((await readCheck(runtime.endpoint, leftUseUri)).state, "SATISFIED");
  const leftPublishUri = uriFor(
    leftUseFinalized.checklistDelta.newlyOpened,
    "/left-publication/",
  );
  await completeSimpleCheck(
    runtime.endpoint,
    "left-publish-attempt-one",
    leftPublishUri,
    leftPublish,
    { "publication status": "published" },
  );
  assert.equal((await readCheck(runtime.endpoint, leftPublishUri)).state, "SATISFIED");

  // This attempt is valid when admitted, but its upstream qualification will
  // be replaced before it finalizes. It must never qualify the reopened Check.
  const staleLeftPublishAdmission = await admit(
    runtime.endpoint,
    "left-publish-attempt-stale",
    leftPublishUri,
  );
  assert.equal(staleLeftPublishAdmission.status, "ADMITTED");
  const stalePublishObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "left-publish-attempt-stale",
    executionHandle: staleLeftPublishAdmission.executionHandle,
    checkUri: leftPublishUri,
    recordedAt: stalePublishObservedAt,
    fact: {
      kind: leftPublish,
      observedAt: stalePublishObservedAt,
      values: { "publication status": "published" },
    },
  })), {});

  // The agent may return to an already satisfied upstream Check after changing
  // the external system. The new accepted Facts replace its active output and
  // invalidate every dependent qualification without erasing history.
  const revisedLeftAdmission = await admit(
    runtime.endpoint,
    "left-attempt-revised",
    leftCheckUri,
  );
  assert.equal(revisedLeftAdmission.status, "ADMITTED");
  const revisedObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "left-attempt-revised",
    executionHandle: revisedLeftAdmission.executionHandle,
    checkUri: leftCheckUri,
    recordedAt: revisedObservedAt,
    fact: {
      kind: leftDiscover,
      observedAt: revisedObservedAt,
      values: { "left count": 1, "left item": "left-2" },
      outputs: [{
        output: "left item",
        value: "left-2",
        parents: [{ kind: "input", port: "workspace", value: "workspace-42" }],
      }],
    },
  })), {});
  const revisedLeft = await finalize(runtime.endpoint, revisedLeftAdmission.executionHandle);
  assert.equal(revisedLeft.verdict, "VALIDATED");
  assert.ok(revisedLeft.checklistDelta.newlyOpened.includes(leftUseUri));
  assert.equal((await readCheck(runtime.endpoint, leftCheckUri)).state, "SATISFIED");
  assert.equal((await readCheck(runtime.endpoint, leftUseUri)).state, "OPEN");
  assert.equal((await readCheck(runtime.endpoint, leftPublishUri)).state, "OPEN");
  assert.equal((await readCheck(runtime.endpoint, rightCheckUri)).state, "SATISFIED");
  assert.equal(
    await finalizationFailureReason(
      runtime.endpoint,
      staleLeftPublishAdmission.executionHandle,
    ),
    "plan-conflict",
  );

  const revisedLeftUseAdmission = await admit(
    runtime.endpoint,
    "left-use-attempt-two",
    leftUseUri,
  );
  assert.equal(revisedLeftUseAdmission.status, "ADMITTED");
  const revisedUseObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "left-use-attempt-two",
    executionHandle: revisedLeftUseAdmission.executionHandle,
    checkUri: leftUseUri,
    recordedAt: revisedUseObservedAt,
    fact: {
      kind: leftUse,
      observedAt: revisedUseObservedAt,
      values: { "left status": "used" },
    },
  })), {});
  assert.equal(
    (await finalize(runtime.endpoint, revisedLeftUseAdmission.executionHandle)).verdict,
    "VALIDATED",
  );
  await completeSimpleCheck(
    runtime.endpoint,
    "left-publish-attempt-two",
    leftPublishUri,
    leftPublish,
    { "publication status": "published" },
  );

  // A later bad observation makes the upstream Check and its dependents not
  // good. The independent branch remains satisfied and the agent can retry.
  const failedLeftAdmission = await admit(
    runtime.endpoint,
    "left-attempt-failed",
    leftCheckUri,
  );
  assert.equal(failedLeftAdmission.status, "ADMITTED");
  const failedObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "left-attempt-failed",
    executionHandle: failedLeftAdmission.executionHandle,
    checkUri: leftCheckUri,
    recordedAt: failedObservedAt,
    fact: {
      kind: leftDiscover,
      observedAt: failedObservedAt,
      values: { "left count": 0, "left item": "left-2" },
    },
  })), {});
  const failedLeft = await finalize(runtime.endpoint, failedLeftAdmission.executionHandle);
  assert.equal(failedLeft.verdict, "NOT_VALIDATED");
  assert.equal((await readCheck(runtime.endpoint, leftCheckUri)).state, "OPEN");
  assert.equal((await readCheck(runtime.endpoint, leftUseUri)).state, "OPEN");
  assert.equal((await readCheck(runtime.endpoint, leftPublishUri)).state, "OPEN");
  assert.equal((await readCheck(runtime.endpoint, rightCheckUri)).state, "SATISFIED");

  const recoveredLeftAdmission = await admit(
    runtime.endpoint,
    "left-attempt-recovered",
    leftCheckUri,
  );
  assert.equal(recoveredLeftAdmission.status, "ADMITTED");
  const recoveredObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "left-attempt-recovered",
    executionHandle: recoveredLeftAdmission.executionHandle,
    checkUri: leftCheckUri,
    recordedAt: recoveredObservedAt,
    fact: {
      kind: leftDiscover,
      observedAt: recoveredObservedAt,
      values: { "left count": 1, "left item": "left-3" },
      outputs: [{
        output: "left item",
        value: "left-3",
        parents: [{ kind: "input", port: "workspace", value: "workspace-42" }],
      }],
    },
  })), {});
  assert.equal(
    (await finalize(runtime.endpoint, recoveredLeftAdmission.executionHandle)).verdict,
    "VALIDATED",
  );
  await completeSimpleCheck(
    runtime.endpoint,
    "left-use-attempt-three",
    leftUseUri,
    leftUse,
    { "left status": "used" },
  );
  await completeSimpleCheck(
    runtime.endpoint,
    "left-publish-attempt-three",
    leftPublishUri,
    leftPublish,
    { "publication status": "published" },
  );
  assert.equal((await readCheck(runtime.endpoint, leftCheckUri)).state, "SATISFIED");
  assert.equal((await readCheck(runtime.endpoint, leftUseUri)).state, "SATISFIED");
  assert.equal((await readCheck(runtime.endpoint, leftPublishUri)).state, "SATISFIED");

  const beforeReplay = await readCheck(runtime.endpoint, rightCheckUri);
  assert.equal(beforeReplay.history.length, 1);

  // Replaying the same admission is stable.
  assert.deepEqual(await postTrace(runtime.endpoint, rightTrace), {});
  const replayedFinalization = await finalize(runtime.endpoint, rightAdmission.executionHandle);
  assert.deepEqual(replayedFinalization, rightFinalized);

  // A separately admitted attempt may report the same semantic Fact. TRUST
  // stores one global Fact and one Snapshot, then projects the existing
  // verdict and delta under the second execution handle.
  const crossAdmissionTrace = otlpTrace({
    attemptKey: "right-attempt-n-replay",
    executionHandle: rightReplayAdmission.executionHandle,
    checkUri: rightCheckUri,
    recordedAt: new Date().toISOString(),
    fact: {
      kind: rightDiscover,
      observedAt,
      values: { "right count": 2, "right item": ["right-1", "right-2"] },
      outputs: ["right-1", "right-2"].map((value) => ({
        output: "right item",
        value,
        parents: [{ kind: "input", port: "workspace", value: "workspace-42" }],
      })),
    },
  });
  assert.deepEqual(await postTrace(runtime.endpoint, crossAdmissionTrace), {});
  const crossAdmissionFinalization = await finalize(
    runtime.endpoint,
    rightReplayAdmission.executionHandle,
  );
  assert.equal(
    crossAdmissionFinalization.executionHandle,
    rightReplayAdmission.executionHandle,
  );
  assert.deepEqual(
    {
      verdict: crossAdmissionFinalization.verdict,
      reasonCode: crossAdmissionFinalization.reasonCode,
      reason: crossAdmissionFinalization.reason,
      checklistDelta: crossAdmissionFinalization.checklistDelta,
    },
    {
      verdict: rightFinalized.verdict,
      reasonCode: rightFinalized.reasonCode,
      reason: rightFinalized.reason,
      checklistDelta: rightFinalized.checklistDelta,
    },
  );
  const afterReplay = await readCheck(runtime.endpoint, rightCheckUri);
  assert.deepEqual(afterReplay, beforeReplay);

  // A NOT_VALIDATED provider observation is not an authoritative declaration:
  // its previously materialized Checks remain visible and OPEN. A later
  // VALIDATED narrowing removes the omitted Check from the current revision,
  // while re-expansion restores the same URI and immutable history.
  await completeSimpleCheck(
    runtime.endpoint,
    "right-use-attempt-before-removal-complete",
    removedRightUseUri,
    rightUse,
    { "right status": "used" },
  );
  const historyBeforeRemoval = await readCheck(runtime.endpoint, removedRightUseUri);
  assert.equal(historyBeforeRemoval.state, "SATISFIED");
  assert.equal(historyBeforeRemoval.history.length, 1);

  const staleRemovedAdmission = await admit(
    runtime.endpoint,
    "right-use-attempt-before-shrink",
    removedRightUseUri,
  );
  assert.equal(staleRemovedAdmission.status, "ADMITTED");
  const removedObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "right-use-attempt-before-shrink",
    executionHandle: staleRemovedAdmission.executionHandle,
    checkUri: removedRightUseUri,
    recordedAt: removedObservedAt,
    fact: {
      kind: rightUse,
      observedAt: removedObservedAt,
      values: { "right status": "used" },
    },
  })), {});

  const failedRightAdmission = await admit(
    runtime.endpoint,
    "right-attempt-not-validated",
    rightCheckUri,
  );
  assert.equal(failedRightAdmission.status, "ADMITTED");
  const failedRightObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "right-attempt-not-validated",
    executionHandle: failedRightAdmission.executionHandle,
    checkUri: rightCheckUri,
    recordedAt: failedRightObservedAt,
    fact: {
      kind: rightDiscover,
      observedAt: failedRightObservedAt,
      values: { "right count": 0, "right item": [] },
    },
  })), {});
  assert.equal(
    (await finalize(runtime.endpoint, failedRightAdmission.executionHandle)).verdict,
    "NOT_VALIDATED",
  );
  const failedRightPlan = await rpc<PlanEngagement>(
    runtime.endpoint,
    "plan.engage",
    engagementRequest,
    auth(credentials.operator),
  );
  assert.equal(failedRightPlan.revision, 14);
  assert.ok(failedRightPlan.checkUris.includes(rightUseUri));
  assert.ok(failedRightPlan.checkUris.includes(removedRightUseUri));
  assert.equal((await readCheck(runtime.endpoint, rightUseUri)).state, "OPEN");
  assert.equal((await readCheck(runtime.endpoint, removedRightUseUri)).state, "OPEN");
  const notValidatedRefusal = await admit(
    runtime.endpoint,
    "right-use-attempt-while-provider-not-validated",
    removedRightUseUri,
  );
  assert.equal(notValidatedRefusal.status, "REFUSED");
  assert.equal(notValidatedRefusal.reasonCode, "check-not-actionable");

  const narrowAdmission = await admit(
    runtime.endpoint,
    "right-attempt-narrow",
    rightCheckUri,
  );
  assert.equal(narrowAdmission.status, "ADMITTED");
  assert.equal(
    await finalizationFailureReason(runtime.endpoint, narrowAdmission.executionHandle),
    "facts-missing",
  );
  const unchangedWhileOpen = await rpc<PlanEngagement>(
    runtime.endpoint,
    "plan.engage",
    engagementRequest,
    auth(credentials.operator),
  );
  assert.equal(unchangedWhileOpen.revision, 14);
  assert.ok(unchangedWhileOpen.checkUris.includes(removedRightUseUri));
  const narrowObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "right-attempt-narrow",
    executionHandle: narrowAdmission.executionHandle,
    checkUri: rightCheckUri,
    recordedAt: narrowObservedAt,
    fact: {
      kind: rightDiscover,
      observedAt: narrowObservedAt,
      values: { "right count": 1, "right item": ["right-1"] },
      outputs: [{
        output: "right item",
        value: "right-1",
        parents: [{ kind: "input", port: "workspace", value: "workspace-42" }],
      }],
    },
  })), {});
  assert.equal((await finalize(runtime.endpoint, narrowAdmission.executionHandle)).verdict, "VALIDATED");
  const narrowedPlan = await rpc<PlanEngagement>(
    runtime.endpoint,
    "plan.engage",
    engagementRequest,
    auth(credentials.operator),
  );
  assert.equal(narrowedPlan.revision, 15);
  assert.ok(narrowedPlan.checkUris.includes(rightUseUri));
  assert.ok(!narrowedPlan.checkUris.includes(removedRightUseUri));

  await runtime.close();
  runtime = await startPublicRuntime("trust-progression-stability-restart-", runtimeOptions);

  const narrowedAfterRestart = await rpc<PlanEngagement>(
    runtime.endpoint,
    "plan.engage",
    engagementRequest,
    auth(credentials.operator),
  );
  assert.equal(narrowedAfterRestart.revision, 15);
  assert.ok(!narrowedAfterRestart.checkUris.includes(removedRightUseUri));
  const removedRefusal = await admit(
    runtime.endpoint,
    "right-use-attempt-while-absent",
    removedRightUseUri,
  );
  assert.equal(removedRefusal.status, "REFUSED");
  assert.equal(removedRefusal.reasonCode, "check-not-found");

  const expandAdmission = await admit(
    runtime.endpoint,
    "right-attempt-expand",
    rightCheckUri,
  );
  assert.equal(expandAdmission.status, "ADMITTED");
  const expandObservedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(runtime.endpoint, otlpTrace({
    attemptKey: "right-attempt-expand",
    executionHandle: expandAdmission.executionHandle,
    checkUri: rightCheckUri,
    recordedAt: expandObservedAt,
    fact: {
      kind: rightDiscover,
      observedAt: expandObservedAt,
      values: { "right count": 2, "right item": ["right-1", "right-2"] },
      outputs: ["right-1", "right-2"].map((value) => ({
        output: "right item",
        value,
        parents: [{ kind: "input", port: "workspace", value: "workspace-42" }],
      })),
    },
  })), {});
  assert.equal((await finalize(runtime.endpoint, expandAdmission.executionHandle)).verdict, "VALIDATED");
  const expandedPlan = await rpc<PlanEngagement>(
    runtime.endpoint,
    "plan.engage",
    engagementRequest,
    auth(credentials.operator),
  );
  assert.equal(expandedPlan.revision, 16);
  assert.ok(expandedPlan.checkUris.includes(removedRightUseUri));
  const restoredHistory = await readCheck(runtime.endpoint, removedRightUseUri);
  assert.equal(restoredHistory.state, "OPEN");
  assert.deepEqual(restoredHistory.history, historyBeforeRemoval.history);
  assert.equal(
    await finalizationFailureReason(
      runtime.endpoint,
      staleRemovedAdmission.executionHandle,
    ),
    "plan-conflict",
  );
  assert.equal(
    (await admit(
      runtime.endpoint,
      "right-use-attempt-after-expand",
      removedRightUseUri,
    )).status,
    "ADMITTED",
  );

  const stillRevisionSixteen = await rpc<PlanEngagement>(
    runtime.endpoint,
    "plan.engage",
    engagementRequest,
    auth(credentials.operator),
  );
  assert.equal(stillRevisionSixteen.revision, 16);
  assert.deepEqual(stillRevisionSixteen.checkUris, revisionThree.checkUris);
});

interface PlanEngagement {
  readonly revision: number;
  readonly checkUris: readonly string[];
}

async function completeSimpleCheck(
  endpoint: string,
  attemptKey: string,
  checkUri: string,
  kind: string,
  values: Readonly<Record<string, unknown>>,
): Promise<Finalization> {
  const admission = await admit(endpoint, attemptKey, checkUri);
  assert.equal(admission.status, "ADMITTED");
  const observedAt = new Date().toISOString();
  assert.deepEqual(await postTrace(endpoint, otlpTrace({
    attemptKey,
    executionHandle: admission.executionHandle,
    checkUri,
    recordedAt: observedAt,
    fact: { kind, observedAt, values },
  })), {});
  const finalized = await finalize(endpoint, admission.executionHandle);
  assert.equal(finalized.verdict, "VALIDATED");
  return finalized;
}

interface Admission {
  readonly status: "ADMITTED" | "REFUSED";
  readonly executionHandle: string;
  readonly reasonCode?: string;
}

interface Finalization {
  readonly executionHandle: string;
  readonly verdict: "VALIDATED" | "NOT_VALIDATED";
  readonly reasonCode: string;
  readonly reason: string;
  readonly checklistDelta: {
    readonly newlySatisfied: readonly string[];
    readonly newlyOpened: readonly string[];
    readonly unchanged: readonly string[];
  };
}

interface CheckView {
  readonly state: "OPEN" | "SATISFIED";
  readonly history: readonly unknown[];
}

type RegistryRole =
  | "publisher"
  | "distribution-verifier"
  | "operator"
  | "observer"
  | "runtime"
  | "runtime-process";

function principal(
  identity: string,
  roles: readonly RegistryRole[],
  credential: string,
  publicKey?: string,
) {
  return {
    identity,
    roles,
    credentialSha256: `sha256:${digest(credential)}`,
    ...(publicKey === undefined ? {} : { publicKey }),
  };
}

async function admit(endpoint: string, attemptKey: string, checkUri: string): Promise<Admission> {
  return rpc(endpoint, "skill.attempt.admit", {
    contract: "trust.skill-admission-request@1",
    attemptKey,
    checkUri,
    releaseDigest,
    environment,
    deploymentKey,
    envelope: "cli",
    runtimeIdentity,
    processIdentity,
  }, auth(credentials.runtime, credentials.process));
}

async function finalize(endpoint: string, executionHandle: string): Promise<Finalization> {
  return rpc(endpoint, "skill.attempt.finalize", {
    contract: "trust.skill-finalization-request@1",
    executionHandle,
  }, auth(credentials.runtime, credentials.process));
}

async function finalizationFailureReason(
  endpoint: string,
  executionHandle: string,
): Promise<string> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${credentials.runtime}`,
      "x-trust-process-authorization": `Bearer ${credentials.process}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "stale-finalization",
      method: "skill.attempt.finalize",
      params: {
        contract: "trust.skill-finalization-request@1",
        executionHandle,
      },
    }),
    redirect: "error",
  });
  assert.equal(response.status, 200);
  const envelope = await response.json() as {
    readonly error?: { readonly data?: { readonly reason?: string } };
  };
  assert.equal(typeof envelope.error?.data?.reason, "string");
  return envelope.error?.data?.reason ?? "";
}

async function readCheck(endpoint: string, checkUri: string): Promise<CheckView> {
  return rpc(endpoint, "check.read", {
    contract: "trust.check-read-request@1",
    checkUri,
  }, auth(credentials.observer));
}

function otlpTrace(input: {
  readonly attemptKey: string;
  readonly executionHandle: string;
  readonly checkUri: string;
  readonly recordedAt: string;
  readonly fact: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
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
          events: [{
            name: "trust.skill.fact",
            attributes: otlpFactAttributes(input.fact, 0),
          }],
        }],
      }],
    }],
  };
}

function stringAttribute(key: string, value: string): Readonly<Record<string, unknown>> {
  return { key, value: { stringValue: value } };
}

async function postTrace(endpoint: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${endpoint}/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${credentials.runtime}`,
      "x-trust-process-authorization": `Bearer ${credentials.process}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
  });
  assert.equal(response.status, 200);
  return response.json();
}

interface RpcAuthorization {
  readonly authorization?: string;
  readonly processAuthorization?: string;
}

function auth(
  authorization?: string,
  processAuthorization?: string,
): RpcAuthorization {
  return {
    ...(authorization === undefined ? {} : { authorization }),
    ...(processAuthorization === undefined ? {} : { processAuthorization }),
  };
}

async function rpc<Result = unknown>(
  endpoint: string,
  method: string,
  params: unknown,
  authorization: RpcAuthorization = {},
): Promise<Result> {
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
  const envelope = await response.json() as
    | { readonly result: Result }
    | { readonly error: unknown };
  if ("error" in envelope) {
    assert.fail(`unexpected ${method} error: ${JSON.stringify(envelope.error)}`);
  }
  return envelope.result;
}

interface CapabilityRequirement {
  readonly capability: string;
  readonly actionContractDigest: string;
}

function requiredRequirement(
  values: ReadonlyMap<string, CapabilityRequirement>,
  capability: string,
): CapabilityRequirement {
  const value = values.get(capability);
  assert.notEqual(value, undefined, `${capability} must have a compiled capability requirement`);
  return value as CapabilityRequirement;
}

function uriFor(values: readonly string[], segment: string): string {
  const value = values.find((candidate) => candidate.includes(segment));
  assert.notEqual(value, undefined, `one Check URI must contain ${segment}`);
  return value as string;
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
