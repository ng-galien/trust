import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { startPublicRuntime, type PublicRuntimeProcess } from "./support/runtime-process.js";

const source = `# language: en
@trust-dsl:1 @procedure:package-inspection @version:1.0.0
Feature: Inspect a package without a preconfigured catalog

  Background: Procedure interface
    Given Skill capability "package.inspect" performs read and is replayable
    And Skill capability "package.inspect" accepts
      | input   | type      | cardinality |
      | subject | reference | one         |
    And Skill capability "package.inspect" reports
      | observation | type   | cardinality | domain           |
      | status      | string | one         | enum "ok", "ko" |
    And Skill capability "package.inspect" exposes outputs
      | output           | from observation | parents         |
      | inspected status | status           | input "subject" |
    And one "package under inspection"
    And one "inspection status" for "package under inspection"

  @scenario:inspect-package
  Scenario: The package is inspected
    Then Check "package inspection" uses Skill capability "package.inspect" on "package under inspection" as input "subject" and materializes "inspection status" from output "inspected status" and must establish "the package is valid"
      | observation | relation | expectation | failure feedback          |
      | status      | equals   | literal "ok" | "the package is invalid" |
    And the scenario is verified when all Skill actions are validated
`;

const correlatedSource = `# language: en
@trust-dsl:1 @procedure:correlated-confirmation @version:1.0.0
Feature: Confirm correlated revisions without positional pairing

  Background: Procedure interface
    Given Skill capability "release.confirm" performs read and is replayable
    And Skill capability "release.confirm" accepts
      | input              | type      | cardinality                                  |
      | candidate project  | reference | many                                         |
      | candidate revision | reference | one for each input "candidate project"      |
    And Skill capability "release.confirm" reports
      | observation     | type      | cardinality                                  | domain                       |
      | tested project  | reference | many                                         | any                          |
      | tested revision | reference | one for each observation "tested project"   | any                          |
      | test result     | string    | one                                          | enum "successful", "failed" |
    And Skill capability "release.confirm" exposes outputs
      | output | from observation | parents |
    And many "candidate project"
    And one "candidate revision" for each "candidate project"

  @scenario:confirm-release
  Scenario: Every project is tested at its own revision
    Then Check "release confirmation" uses Skill capability "release.confirm" on all "candidate project" as input "candidate project" using all "candidate revision" as input "candidate revision" and must establish "every candidate revision was tested"
      | observation     | relation | expectation                    | failure feedback                          |
      | tested revision | equals   | context "candidate revision"  | "a project was tested at another revision" |
      | test result     | equals   | literal "successful"           | "the release confirmation failed"       |
    And the scenario is verified when all Skill actions are validated
`;

interface CompileResult {
  readonly contract: "trust.compiled-procedure@2";
  readonly procedure: string;
  readonly version: string;
  readonly source: string;
  readonly definitionDigest: string;
  readonly requiredCapabilities: ReadonlyArray<{
    readonly capability: string;
    readonly contractCoreDigest: string;
    readonly actionContractDigest: string;
    readonly contract: {
      readonly effect: "read";
      readonly replay: "replayable";
      readonly inputs: Readonly<Record<string, {
        readonly type: string;
        readonly cardinality: string;
        readonly parents: ReadonlyArray<{ readonly kind: string; readonly port: string }>;
      }>>;
      readonly observations: Readonly<
        Record<
          string,
          {
            readonly type: string;
            readonly cardinality: string;
            readonly domain: { readonly kind: string; readonly values?: readonly string[] };
            readonly parents: ReadonlyArray<{ readonly kind: string; readonly port: string }>;
          }
        >
      >;
      readonly outputs: Readonly<
        Record<
          string,
          {
            readonly observation: string;
            readonly parents: ReadonlyArray<{ readonly kind: string; readonly port: string }>;
          }
        >
      >;
    };
  }>;
  readonly roles: ReadonlyArray<{
    readonly name: string;
    readonly cardinality: string;
    readonly valueType: string;
    readonly materialization: { readonly kind: string };
  }>;
  readonly checks: ReadonlyArray<{
    readonly capabilityContract: { readonly capability: string; readonly digest: string };
    readonly compiledCheckDigest: string;
    readonly uriTemplate: {
      readonly target: {
        readonly primary: { readonly role: string; readonly selection: string };
        readonly using: ReadonlyArray<{ readonly role: string; readonly selection: string }>;
      };
    };
    readonly name: string;
    readonly requiredCheckObservations: readonly string[];
    readonly inputBindings: ReadonlyArray<{
      readonly input: string;
      readonly role: string;
      readonly selection: string;
    }>;
    readonly materializes: ReadonlyArray<{
      readonly output: string;
      readonly role: string;
      readonly observation: string;
      readonly valueType: string;
      readonly sourceCardinality: string;
      readonly cardinality: string;
      readonly parents: ReadonlyArray<{
        readonly kind: string;
        readonly port: string;
        readonly role: string;
        readonly each: boolean;
      }>;
    }>;
  }>;
}

let runtime: PublicRuntimeProcess;

before(async () => {
  runtime = await startPublicRuntime("trust-autonomous-procedure-");
});

after(async () => {
  await runtime.close();
});

async function compile(candidateSource = source): Promise<CompileResult> {
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "compile-autonomous",
      method: "procedure.definition.compile",
      params: { source: candidateSource, sourceName: "package-inspection.feature" },
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    readonly result?: CompileResult;
    readonly error?: unknown;
  };
  assert.ok(payload.result, `unexpected compilation failure: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function rawCompile(params: Record<string, unknown>) {
  const response = await fetch(`${runtime.endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "compile-raw",
      method: "procedure.definition.compile",
      params,
    }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function assertCompilationRejected(
  candidateSource: string,
  reason: string,
  sourceName: string,
): Promise<void> {
  const envelope = await rawCompile({ source: candidateSource, sourceName });
  assert.equal(
    ((envelope.error as { data?: { reason?: string } } | undefined)?.data?.reason),
    reason,
    JSON.stringify(envelope),
  );
}

test("a running TRUST server compiles an autonomous Feature without a business catalog", async () => {
  const first = await compile();
  const replay = await compile();
  const editorialVariant = await compile(
    source.replace("Feature: Package inspection", "# editor-only comment\nFeature: Package inspection"),
  );

  assert.equal(first.contract, "trust.compiled-procedure@2");
  assert.equal(first.procedure, "package-inspection");
  assert.equal(first.version, "1.0.0");
  assert.equal(first.source, source);
  assert.match(first.definitionDigest, /^[a-f0-9]{64}$/);
  assert.equal(replay.definitionDigest, first.definitionDigest);
  assert.equal(
    editorialVariant.definitionDigest,
    first.definitionDigest,
    "comments must not change the semantic procedure identity",
  );

  assert.equal(first.requiredCapabilities.length, 1);
  const required = first.requiredCapabilities[0];
  assert.ok(required);
  assert.equal(required.capability, "package.inspect");
  assert.match(required.contractCoreDigest, /^[a-f0-9]{64}$/);
  assert.match(required.actionContractDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(required.contract, {
    effect: "read",
    replay: "replayable",
    inputs: {
      subject: { type: "reference", cardinality: "one", parents: [] },
    },
    observations: {
      status: {
        type: "string",
        cardinality: "one",
        domain: { kind: "enum", values: ["ko", "ok"] },
        parents: [],
      },
    },
    outputs: {
      "inspected status": {
        observation: "status",
        parents: [{ kind: "input", port: "subject" }],
      },
    },
  });

  assert.equal(first.checks.length, 1);
  const check = first.checks[0];
  assert.ok(check);
  assert.deepEqual(check.capabilityContract, {
    capability: "package.inspect",
    digest: required.actionContractDigest,
  });
  assert.match(check.compiledCheckDigest, /^[a-f0-9]{64}$/);
  assert.equal(check.name, "package inspection");
  assert.deepEqual(check.inputBindings, [
    { input: "subject", role: "package under inspection", selection: "one" },
  ]);
  assert.deepEqual(check.materializes, [
    {
      output: "inspected status",
      role: "inspection status",
      observation: "status",
      valueType: "string",
      sourceCardinality: "one",
      cardinality: "one",
      parents: [{
        kind: "input",
        port: "subject",
        role: "package under inspection",
        each: false,
      }],
    },
  ]);
  assert.ok(!("actionContractCatalog" in first));
  assert.equal(JSON.stringify(first).includes('"report"'), false);
  assert.equal(JSON.stringify(first).includes('"alias"'), false);
  assert.equal(JSON.stringify(first).includes("skillAction"), false);
});

test("the public compiler rejects the former external business catalog parameter", async () => {
  const response = await rawCompile({
    source,
    sourceName: "package-inspection.feature",
    actionContracts: {
      contract: "trust.action-contract-catalog@1",
      actions: {},
    },
  });
  assert.deepEqual(response.error, { code: -32602, message: "Invalid params" });
});

test("the public compiler requires the exact autonomous TRUST DSL version", async () => {
  await assertCompilationRejected(
    source.replace("@trust-dsl:1 ", ""),
    "invalid-procedure",
    "missing-trust-dsl-version.feature",
  );
  await assertCompilationRejected(
    source.replace("@trust-dsl:1", "@trust-dsl:2"),
    "invalid-procedure",
    "unsupported-trust-dsl-version.feature",
  );
});

test("the public compiler rejects role cycles and keeps URI encoding out of fixed product values", async () => {
  await assertCompilationRejected(
    source.replace(
      '    And one "package under inspection"\n'
        + '    And one "inspection status" for "package under inspection"',
      '    And one "package under inspection" for "inspection status"\n'
        + '    And one "inspection status" for "package under inspection"',
    ),
    "dependency-cycle",
    "role-cycle.feature",
  );

  const humanTarget = await compile(source.replace(
    '    And one "package under inspection"',
    '    And one "package under inspection" fixed as "Payment API / Europe"',
  ));
  assert.deepEqual(
    humanTarget.roles.find(({ name }) => name === "package under inspection")?.materialization,
    { kind: "static", value: "Payment API / Europe" },
  );
});

test("the public compiler closes agent-owned declarations inside the Feature", async () => {
  const agentOwned = await compile(source.replace(
    '    And one "package under inspection"',
    '    And one "package under inspection" declared by agent',
  ));
  assert.deepEqual(
    agentOwned.roles.find(({ name }) => name === "package under inspection")?.materialization,
    { kind: "agent-declaration" },
  );

  await assertCompilationRejected(
    source.replace(
      '    And one "inspection status" for "package under inspection"',
      '    And one "inspection status" declared by agent for "package under inspection"',
    ),
    "invalid-procedure",
    "skill-output-cannot-be-agent-declared.feature",
  );
});

test("the public compiler preserves correlated ports as coordinates instead of positional arrays", async () => {
  const compiled = await compile(correlatedSource);
  const reordered = await compile(
    correlatedSource
      .replace(
        '      | candidate project  | reference | many                                         |\n'
          + '      | candidate revision | reference | one for each input "candidate project"      |',
        '      | candidate revision | reference | one for each input "candidate project"      |\n'
          + '      | candidate project  | reference | many                                         |',
      )
      .replace(
        '      | tested project  | reference | many                                         | any                          |\n'
          + '      | tested revision | reference | one for each observation "tested project"   | any                          |\n'
          + '      | test result     | string    | one                                          | enum "successful", "failed" |',
        '      | test result     | string    | one                                          | enum "successful", "failed" |\n'
          + '      | tested revision | reference | one for each observation "tested project"   | any                          |\n'
          + '      | tested project  | reference | many                                         | any                          |',
      ),
  );
  assert.equal(reordered.definitionDigest, compiled.definitionDigest);
  assert.equal(
    reordered.checks[0]?.compiledCheckDigest,
    compiled.checks[0]?.compiledCheckDigest,
    "closed table row order must not change Check identity",
  );
  const requirement = compiled.requiredCapabilities[0];
  assert.ok(requirement);
  assert.deepEqual(requirement.contract.inputs, {
    "candidate project": { type: "reference", cardinality: "many", parents: [] },
    "candidate revision": {
      type: "reference",
      cardinality: "one",
      parents: [{ kind: "input", port: "candidate project" }],
    },
  });
  assert.deepEqual(requirement.contract.observations["tested revision"], {
    type: "reference",
    cardinality: "one",
    domain: { kind: "any" },
    parents: [{ kind: "observation", port: "tested project" }],
  });
  assert.deepEqual(compiled.checks[0]?.inputBindings, [
    { input: "candidate project", role: "candidate project", selection: "all" },
    { input: "candidate revision", role: "candidate revision", selection: "all" },
  ]);

});

test("the product Feature compiles its ten exact capabilities and twelve Check templates", async () => {
  const productSource = await readFile(
    new URL(
      "../../../../assets/procedures/01-defect-correction-multi-project.feature",
      import.meta.url,
    ),
    "utf8",
  );
  const compiled = await compile(productSource);
  assert.equal(compiled.procedure, "defect-correction");
  assert.equal(compiled.version, "3.0.0");
  assert.equal(compiled.requiredCapabilities.length, 10);
  assert.equal(compiled.checks.length, 12);
  assert.deepEqual(
    compiled.requiredCapabilities.map((requirement) => requirement.capability).sort(),
    [
      "docker.image-build",
      "git.head-compare",
      "git.head-read",
      "git.worktree-inspect",
      "jira.issue-read",
      "kind.image-load",
      "kubernetes.rollout",
      "maven.defect-reproduce",
      "maven.fix-confirm",
      "maven.project-verify",
    ],
  );
  assert.deepEqual(
    Object.keys(compiled.requiredCapabilities.find(
      ({ capability }) => capability === "jira.issue-read",
    )?.contract.observations ?? {}).sort(),
    ["description", "issue type", "summary", "workflow status"],
  );
  assert.deepEqual(
    Object.keys(compiled.requiredCapabilities.find(
      ({ capability }) => capability === "maven.defect-reproduce",
    )?.contract.observations ?? {}).sort(),
    ["acceptance criterion", "test result"],
  );
  assert.deepEqual(
    compiled.checks.find((check) => check.name === "issue read")
      ?.requiredCheckObservations,
    [],
  );
  assert.deepEqual(
    compiled.checks.find((check) => check.name === "defect reproduction")
      ?.requiredCheckObservations,
    [],
  );
  assert.deepEqual(
    compiled.checks.find((check) => check.name === "defect reproduction")
      ?.inputBindings,
    [
      { input: "acceptance criterion", role: "acceptance criterion", selection: "each" },
      { input: "test project", role: "acceptance project", selection: "one" },
      { input: "test revision", role: "acceptance test commit", selection: "one" },
      { input: "issue", role: "jira issue", selection: "one" },
    ],
  );
  assert.deepEqual(
    compiled.checks.find((check) => check.name === "fix confirmation")
      ?.inputBindings,
    [
      { input: "acceptance criterion", role: "acceptance criterion", selection: "each" },
      { input: "test project", role: "acceptance project", selection: "one" },
      { input: "test revision", role: "acceptance test commit", selection: "one" },
      { input: "issue", role: "jira issue", selection: "one" },
      { input: "candidate project", role: "affected project", selection: "all" },
      { input: "candidate revision", role: "fix commit", selection: "all" },
    ],
  );
  assert.deepEqual(
    compiled.checks.find((check) => check.name === "fix confirmation")
      ?.uriTemplate.target.primary,
    { role: "acceptance criterion", selection: "each" },
  );

  const incompatibleCheckObservation = await rawCompile({
    source: productSource.replace(
      '| test result          | equals   | literal "defect-reproduced"',
      '| test result          | equals   | observation "commits ahead" from Check "acceptance test comparison"',
    ),
    sourceName: "incompatible-check-observation.feature",
  });
  assert.ok("error" in incompatibleCheckObservation, "Check observation predicates must have exact typed shapes");

  const expandedCheck = await rawCompile({
    source: productSource
      .replace(
        '    Given scenario "acceptance-test-commit" is validated\n    Then Check "defect reproduction" uses Skill capability "maven.defect-reproduce"',
        '    Given scenario "acceptance-test-commit" is validated\n'
          + '    And scenario "code-baselines" is validated\n'
          + '    Then Check "defect reproduction" uses Skill capability "maven.defect-reproduce"',
      )
      .replace(
        '| test result          | equals   | literal "defect-reproduced"',
        '| test result          | equals   | observation "working tree" from Check "code baseline"',
      ),
    sourceName: "expanded-check.feature",
  });
  assert.ok("error" in expandedCheck, "one named Check cannot ambiguously denote several materialized Checks");
});

test("the closed grammar rejects unknown tags, a Given Check and implicit expectations", async () => {
  const unknownTag = await rawCompile({
    source: source.replace("@procedure:package-inspection", "@unowned\n@procedure:package-inspection"),
    sourceName: "unknown-tag.feature",
  });
  assert.ok("error" in unknownTag);

  const wrongKeyword = await rawCompile({
    source: source.replace('    Then Check "package inspection"', '    Given Check "package inspection"'),
    sourceName: "wrong-keyword.feature",
  });
  assert.ok("error" in wrongKeyword);

  const bareLiteral = await rawCompile({
    source: source.replace('| status      | equals   | literal "ok" |', '| status      | equals   | ok |'),
    sourceName: "bare-literal.feature",
  });
  assert.ok("error" in bareLiteral);

  const bareOne = await rawCompile({
    source: source.replace('| status      | equals   | literal "ok" |', '| status      | equals   | one |'),
    sourceName: "bare-one.feature",
  });
  assert.ok("error" in bareOne);

  const ignoredDocString = await rawCompile({
    source: source.replace(
      '    Given Skill capability "package.inspect" performs read and is replayable',
      '    Given Skill capability "package.inspect" performs read and is replayable\n'
        + '      """\n'
        + '      undeclared meaning\n'
        + '      """',
    ),
    sourceName: "ignored-docstring.feature",
  });
  assert.ok("error" in ignoredDocString);

});

test("a published autonomous Feature survives a runtime restart without bootstrap configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-published-procedure-"));
  const databasePath = path.join(directory, "trust.sqlite");
  const publisherToken = "autonomous-procedure-publisher";
  const operatorToken = "autonomous-procedure-operator";
  const principals = [
    {
      identity: "spiffe://trust.test/publishers/product",
      roles: ["publisher"] as const,
      credentialSha256: `sha256:${createHash("sha256").update(publisherToken).digest("hex")}`,
    },
    {
      identity: "spiffe://trust.test/operators/test-environment",
      roles: ["operator"] as const,
      credentialSha256: `sha256:${createHash("sha256").update(operatorToken).digest("hex")}`,
    },
  ];
  let first: PublicRuntimeProcess | undefined;
  let restarted: PublicRuntimeProcess | undefined;
  try {
    first = await startPublicRuntime("trust-publish-first-", {
      databasePath,
      registryPrincipalConfigurations: principals,
    });
    const compiled = await compile();
    const requirement = compiled.requiredCapabilities[0];
    assert.ok(requirement);
    const secondarySource = source
      .replace("@procedure:package-inspection @version:1.0.0", "@procedure:package-inspection-extended @version:1.0.0")
      .replace('enum "ok", "ko"', 'enum "ok", "ko", "unknown"');
    const secondaryCompiled = await compile(secondarySource);
    const secondaryRequirement = secondaryCompiled.requiredCapabilities[0];
    assert.ok(secondaryRequirement);
    assert.notEqual(secondaryRequirement.actionContractDigest, requirement.actionContractDigest);
    const publisherIdentity = "spiffe://trust.test/publishers/product";
    const releaseDigest = `sha256:${"b".repeat(64)}`;
    const release = {
      contract: "trust.skill-release@1",
      skill: "trust.package-inspector",
      version: "1.0.0",
      releaseDigest,
      publisher: publisherIdentity,
      implements: [
        {
          capability: requirement.capability,
          actionContractDigest: secondaryRequirement.actionContractDigest,
        },
        {
          capability: requirement.capability,
          actionContractDigest: requirement.actionContractDigest,
        },
      ],
      entrypoints: { cli: "scripts/run.ts" },
      probes: ["package-system-ready"],
    };
    await procedureRpc(first.endpoint, "skill.release.claim", { release }, publisherToken);
    const unpublishedAuthorization = await procedureRpcEnvelope(
      first.endpoint,
      "skill.release.authorization.set",
      { environment: "test", releaseDigest, decision: "ALLOW" },
      operatorToken,
    );
    assert.equal((unpublishedAuthorization.error as { code?: number } | undefined)?.code, -32020);

    const published = await procedureRpc(first.endpoint, "procedure.definition.publish", {
      source,
      sourceName: "package-inspection.feature",
    }, publisherToken);
    const publication = published.result as {
      readonly contract: string;
      readonly definition: CompileResult;
      readonly publishedBy: string;
      readonly publishedAt: string;
    };
    assert.equal(publication.contract, "trust.published-procedure@1");
    assert.equal(publication.definition.procedure, "package-inspection");
    assert.equal(publication.definition.source, source);
    assert.equal(publication.publishedBy, "spiffe://trust.test/publishers/product");
    await procedureRpc(first.endpoint, "procedure.definition.publish", {
      source: secondarySource,
      sourceName: "package-inspection-extended.feature",
    }, publisherToken);
    await procedureRpc(first.endpoint, "procedure.definition.publish", {
      source: correlatedSource,
      sourceName: "correlated-confirmation.feature",
    }, publisherToken);
    const correlatedEngagement = await procedureRpc(first.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "correlated-confirmation",
      procedureVersion: "1.0.0",
      plan: "correlated-release-confirmation",
      environment: "test",
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
    }, operatorToken);
    assert.equal((correlatedEngagement.result as { status?: string }).status, "ENGAGED");
    const incompleteCorrelation = await procedureRpcEnvelope(first.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "correlated-confirmation",
      procedureVersion: "1.0.0",
      plan: "incomplete-correlated-release-confirmation",
      environment: "test",
      rootInputs: {
        "candidate project": ["project-b", "project-a"],
        "candidate revision": [{
          value: "revision-a",
          parents: [{ role: "candidate project", value: "project-a" }],
        }],
      },
    }, operatorToken);
    assert.equal((incompleteCorrelation.error as { code?: number } | undefined)?.code, -32030);
    const authorized = await procedureRpc(
      first.endpoint,
      "skill.release.authorization.set",
      { environment: "test", releaseDigest, decision: "ALLOW" },
      operatorToken,
    );
    assert.equal((authorized.result as { decision?: string }).decision, "ALLOW");

    const replay = await procedureRpc(first.endpoint, "procedure.definition.publish", {
      source,
      sourceName: "moved-package-inspection.feature",
    }, publisherToken);
    const replayed = replay.result as typeof publication;
    assert.equal(replayed.definition.definitionDigest, publication.definition.definitionDigest);
    assert.equal(replayed.publishedAt, publication.publishedAt);
    assert.equal(replayed.publishedBy, publication.publishedBy);

    const engaged = await procedureRpc(first.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "package-inspection",
      procedureVersion: "1.0.0",
      plan: "published-package-inspection",
      environment: "test",
      rootInputs: { "package under inspection": "pkg-001" },
    }, operatorToken);
    const plan = engaged.result as {
      readonly status: string;
      readonly revision: number;
      readonly checkUris: readonly string[];
    };
    assert.equal(plan.status, "ENGAGED");
    assert.equal(plan.revision, 1);
    assert.equal(plan.checkUris.length, 1);
    assert.match(plan.checkUris[0] ?? "", /\/package-inspect$/);

    const conflict = await procedureRpcEnvelope(first.endpoint, "procedure.definition.publish", {
      source: source.replace(
        "Feature: Inspect a package without a preconfigured catalog",
        "Feature: Inspect a changed package contract",
      ),
      sourceName: "changed-package-inspection.feature",
    }, publisherToken);
    assert.equal((conflict.error as { code?: number } | undefined)?.code, -32010);

    await first.close();
    first = undefined;
    restarted = await startPublicRuntime("trust-publish-restart-", {
      databasePath,
      registryPrincipalConfigurations: principals,
    });
    const read = await procedureRpc(restarted.endpoint, "procedure.definition.read", {
      procedure: "package-inspection",
      version: "1.0.0",
    }, publisherToken);
    const restored = read.result as typeof publication;
    assert.equal(restored.definition.definitionDigest, publication.definition.definitionDigest);
    assert.equal(restored.definition.source, source);
    const reauthorized = await procedureRpc(
      restarted.endpoint,
      "skill.release.authorization.set",
      { environment: "test", releaseDigest, decision: "ALLOW" },
      operatorToken,
    );
    assert.equal((reauthorized.result as { decision?: string }).decision, "ALLOW");
    assert.deepEqual(restored.definition.requiredCapabilities, publication.definition.requiredCapabilities);
    assert.equal(JSON.stringify(restored).includes("actionContractCatalog"), false);
  } finally {
    await first?.close();
    await restarted?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function procedureRpc(
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  token: string,
): Promise<Record<string, unknown>> {
  const payload = await procedureRpcEnvelope(endpoint, method, params, token);
  assert.equal("error" in payload, false, JSON.stringify(payload));
  return payload;
}

async function procedureRpcEnvelope(
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  token: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<Record<string, unknown>>;
}
