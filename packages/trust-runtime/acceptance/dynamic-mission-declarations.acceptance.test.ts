import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CheckAttemptAdmissionResult, CheckFinalizationResult, PlanView } from "@trust/extension-sdk";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const execute = promisify(execFile);
const parentSource = `@trust-dsl:1 @procedure:mission-orchestration @version:1.0.0
Feature: Declare specialized work without replacing accepted missions
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repositories. | Change external state. |
    And missions "work" declared by agent
  @scenario:work
  Scenario: Execute declared work
    Then Invocation "execute-work" runs each declared Procedure in "work" and must establish "declared work completed"
`;

function childSource(name: string, operation = "git.head-read", version = "1.0.0") {
  return `@trust-dsl:1 @procedure:${name} @version:${version}
Feature: Observe the delegated repository
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the repository. | Modify the repository or qualification criteria. |
    And one reference "repository"
  @scenario:observe
  Scenario: Observe
    Then Check "diagnostic" runs Operation "${operation}@1.0.0" on "repository" as Input "project" and must establish "the diagnostic is available"
      """js
      fact.workingTree === "clean" || fail("the repository is dirty")
      """
`;
}

async function setup(workspaceRoot = root) {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-mission-declarations-"));
  const options = {
    storage: { kind: "pglite" as const, directory: path.join(directory, "pglite") },
    operationsDirectory: path.join(root, "assets/operations"),
    environments: { local: { workspaceRoot } },
  };
  let runtime = await startPublicRuntime("trust-mission-process-", options);
  const request = async <T = unknown>(method: string, params: unknown): Promise<{ result?: T; error?: unknown }> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ result?: T; error?: unknown }>;
  };
  const rpc = async <T = unknown>(method: string, params: unknown): Promise<T> => {
    const envelope = await request<T>(method, params);
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    assert.notEqual(envelope.result, undefined);
    return envelope.result as T;
  };
  const read = () => rpc<PlanView>("plan.read", { plan: "mission-root" });
  const declaration = async (missions: unknown) => ({
    contract: "trust.plan-declaration-replacement-request@1",
    plan: "mission-root",
    expectedRevision: (await read()).revision,
    declarations: {},
    missionDeclarations: { work: missions },
  });
  const mcp = async (
    name: string,
    args: unknown,
  ): Promise<{ error?: unknown; result?: { isError?: boolean; content: unknown[] } }> => {
    const response = await fetch(`${runtime.endpoint}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.json() as Promise<{ error?: unknown; result?: { isError?: boolean; content: unknown[] } }>;
  };
  return {
    get endpoint() {
      return runtime.endpoint;
    },
    rpc,
    request,
    read,
    declaration,
    mcp,
    async initialize(mode = "dry-run", source = parentSource) {
      await rpc("procedure.publish", { source: childSource("mission-published") });
      await rpc("procedure.publish", { source });
      await rpc("plan.engage", {
        contract: "trust.plan-engagement-request@1",
        procedure: "mission-orchestration",
        procedureVersion: "1.0.0",
        plan: "mission-root",
        mode,
        environment: "local",
        rootInputs: {},
      });
    },
    async restart() {
      await runtime.close();
      runtime = await startPublicRuntime("trust-mission-process-", options);
    },
    async close() {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const publishedMission = {
  id: "published-work",
  definition: { kind: "published", reference: "mission-published@^1.0.0" },
  rootInputs: { repository: "published-repository" },
};

test("published and inline missions retain accepted children, definitions and qualifications across additions and restart", {
  timeout: 60_000,
}, async () => {
  const fixture = await setup();
  try {
    await fixture.initialize();
    const operationSource = (
      await readFile(path.join(root, "assets/operations/git.head-read.feature"), "utf8")
    ).replace("@operation:git.head-read", "@operation:mission.observe");
    const inlineMission = {
      id: "inline-work",
      definition: {
        kind: "inline",
        procedureSource: childSource("mission-inline", "mission.observe"),
        operationSources: [operationSource],
      },
      rootInputs: { repository: "inline-repository" },
    };
    const missions = [publishedMission, inlineMission];
    await fixture.rpc("plan.declarations.replace", await fixture.declaration(missions));
    const accepted = await fixture.read();
    assert.equal(accepted.invocations.length, 2);
    assert.deepEqual(
      accepted.invocations
        .map((invocation) => invocation.mission)
        .sort((a, b) => (a?.id ?? "").localeCompare(b?.id ?? "")),
      [
        { collection: "work", id: "inline-work" },
        { collection: "work", id: "published-work" },
      ],
    );
    assert.equal(
      accepted.resolvedMissions?.work?.find((mission) => mission.id === "published-work")?.procedure.version,
      "1.0.0",
    );
    const children = accepted.invocations.map((invocation) => {
      assert.ok(invocation.childPlan);
      return invocation.childPlan;
    });
    assert.equal(new Set(children).size, 2);
    assert.ok(children.every((child: unknown) => typeof child === "string"));
    const catalog = JSON.stringify(await fixture.rpc("procedure.list", {}));
    assert.doesNotMatch(catalog, /mission-inline/);
    assert.doesNotMatch(JSON.stringify(await fixture.rpc("operation.list", {})), /mission\.observe/);
    const mcpParent = await fixture.mcp("trust_plan_read", { plan: "mission-root" });
    assert.equal(mcpParent.error, undefined);
    assert.ok(mcpParent.result);
    assert.ok(!mcpParent.result.isError);
    for (const child of children) {
      assert.ok(JSON.stringify(mcpParent.result).includes(child));
      const view: PlanView = await fixture.rpc<PlanView>("plan.read", { plan: child });
      assert.equal(view.checks.length, 1);
      assert.ok(view.checks[0]);
      const admitted: CheckAttemptAdmissionResult = await fixture.rpc<CheckAttemptAdmissionResult>(
        "check.attempt.admit",
        {
          contract: "trust.check-admission-request@1",
          checkUri: view.checks[0].checkUri,
          attemptKey: `mission-${child}`,
        },
      );
      assert.equal(admitted.status, "ADMITTED", JSON.stringify(admitted));
      assert.equal(admitted.operation.version, "1.0.0");
      const observedAt = new Date().toISOString();
      await fixture.rpc("check.attempt.facts", {
        contract: "trust.fact-batch-request@1",
        attemptHandle: admitted.attemptHandle,
        attemptKey: admitted.attemptKey,
        executionId: admitted.executionId,
        checkUri: admitted.checkUri,
        recordedAt: observedAt,
        facts: [
          { kind: admitted.operation.operation, observedAt, values: { workingTree: "clean", headRevision: "head" } },
        ],
      });
      assert.equal(
        (
          await fixture.rpc<CheckFinalizationResult>("check.attempt.finalize", {
            contract: "trust.attempt-finalization-request@1",
            attemptHandle: admitted.attemptHandle,
          })
        ).verdict,
        "VALIDATED",
      );
    }
    await fixture.rpc("procedure.publish", { source: childSource("mission-published", "git.head-read", "1.1.0") });
    const beforeReplay = await fixture.read();
    const replay = await fixture.declaration(missions);
    const mcpReplay = await fixture.mcp("trust_plan_declarations_replace", {
      plan: replay.plan,
      expectedRevision: replay.expectedRevision,
      declarations: replay.declarations,
      missionDeclarations: replay.missionDeclarations,
    });
    assert.equal(mcpReplay.error, undefined);
    assert.ok(mcpReplay.result && !mcpReplay.result.isError, JSON.stringify(mcpReplay));
    assert.deepEqual((await fixture.read()).invocations, beforeReplay.invocations);
    assert.deepEqual((await fixture.read()).resolvedMissions, accepted.resolvedMissions);
    const additional = { ...publishedMission, id: "later-work" };
    await fixture.rpc("plan.declarations.replace", await fixture.declaration([...missions, additional]));
    const extended = await fixture.read();
    assert.equal(extended.invocations.length, 3);
    assert.equal(
      extended.resolvedMissions?.work?.find((mission) => mission.id === "later-work")?.procedure.version,
      "1.1.0",
    );
    for (const child of children) {
      assert.ok(extended.invocations.some((invocation) => invocation.childPlan === child));
      assert.equal((await fixture.rpc<PlanView>("plan.read", { plan: child })).checks[0]?.state, "SATISFIED");
    }
    await fixture.restart();
    assert.deepEqual((await fixture.read()).invocations, extended.invocations);
    assert.deepEqual((await fixture.read()).resolvedMissions, extended.resolvedMissions);
    for (const child of children)
      assert.equal((await fixture.rpc<PlanView>("plan.read", { plan: child })).checks[0]?.state, "SATISFIED");
  } finally {
    await fixture.close();
  }
});

test("mission declaration boundaries reject malformed, uncompilable and destructive batches atomically", {
  timeout: 40_000,
}, async () => {
  const fixture = await setup();
  try {
    await fixture.initialize();
    await fixture.rpc("plan.declarations.replace", await fixture.declaration([publishedMission]));
    const accepted = await fixture.read();
    const invalidBatches = [
      [],
      [{ ...publishedMission, rootInputs: { repository: "changed" } }],
      [publishedMission, { ...publishedMission }],
      [
        publishedMission,
        {
          id: "invalid",
          definition: { kind: "inline", procedureSource: "not a Procedure", operationSources: [] },
          rootInputs: {},
        },
      ],
      [
        publishedMission,
        { id: "unknown", definition: { kind: "published", reference: "absent-procedure@1.0.0" }, rootInputs: {} },
      ],
      [publishedMission, { id: "malformed", definition: { kind: "arbitrary" }, rootInputs: {} }],
    ];
    for (const batch of invalidBatches) {
      const rejected = await fixture.request("plan.declarations.replace", await fixture.declaration(batch));
      assert.ok(rejected.error, JSON.stringify(rejected));
      const after = await fixture.read();
      assert.equal(after.revision, accepted.revision);
      assert.deepEqual(after.invocations, accepted.invocations);
    }
    const invalid = await fixture.declaration([{ ...publishedMission, definition: { kind: "published" } }]);
    const mcpResult = await fixture.mcp("trust_plan_declarations_replace", {
      plan: invalid.plan,
      expectedRevision: invalid.expectedRevision,
      declarations: invalid.declarations,
      missionDeclarations: invalid.missionDeclarations,
    });
    assert.ok(mcpResult.error || mcpResult.result?.isError, JSON.stringify(mcpResult));
    assert.equal((await fixture.read()).revision, accepted.revision);
    const contextualCases = [
      {
        id: "bad-source",
        definition: {
          kind: "inline",
          procedureSource: childSource("invalid-mission").replace(
            'fact.workingTree === "clean"',
            "fact.workingTree ===",
          ),
          operationSources: [],
        },
        rootInputs: { repository: "example" },
        phase: "compilation",
      },
      {
        id: "bad-reference",
        definition: { kind: "published", reference: "absent-procedure@1.0.0" },
        rootInputs: {},
        phase: "resolution",
      },
      {
        id: "bad-inputs",
        definition: publishedMission.definition,
        rootInputs: { unexpected: "value" },
        phase: "inputs",
      },
    ];
    for (const { phase, ...mission } of contextualCases) {
      const params = await fixture.declaration([publishedMission, mission]);
      const rpcFailure = await fixture.request("plan.declarations.replace", params);
      assert.ok(rpcFailure.error);
      const mcpFailure = await fixture.mcp("trust_plan_declarations_replace", {
        plan: params.plan,
        expectedRevision: params.expectedRevision,
        declarations: params.declarations,
        missionDeclarations: params.missionDeclarations,
      });
      assert.ok(mcpFailure.error || mcpFailure.result?.isError);
      for (const failure of [rpcFailure.error, mcpFailure]) {
        const diagnostic = JSON.stringify(failure).replaceAll('\\"', '"');
        assert.ok(diagnostic.includes(`Mission collection "work", mission "${mission.id}", ${phase}:`), diagnostic);
        assert.match(diagnostic, /No changes accepted/);
        if (phase === "compilation") assert.match(diagnostic, /\[invalid-procedure\] procedure\.feature:11:7:/);
        if (phase === "resolution") assert.match(diagnostic, /No published Procedure matches.*absent-procedure/);
        if (phase === "inputs") assert.match(diagnostic, /repository|unexpected/);
      }
      const unchanged = await fixture.read();
      assert.equal(unchanged.revision, accepted.revision);
      assert.deepEqual(unchanged.invocations, accepted.invocations);
      assert.deepEqual(unchanged.resolvedMissions, accepted.resolvedMissions);
    }
  } finally {
    await fixture.close();
  }
});

test("live inline missions run through the packaged Runner, reopen parent verification on append and surface escalation", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-live-mission-"));
  const skill = path.join(directory, "runner");
  const fixture = await setup(directory);
  try {
    await writeFile(path.join(directory, "trust-smoke.json"), JSON.stringify({ signal: "ready" }));
    await execute(
      process.execPath,
      [path.join(root, "packages/trust-runner/scripts/package-skill.ts"), "--output", skill],
      { cwd: root },
    );
    const parent =
      parentSource.replace(
        '    And missions "work"',
        '    And one string "expected signal" fixed as "ready"\n    And missions "work"',
      ) +
      `
  @scenario:final
  Scenario: Verify all declared work
    Given scenario "work" is validated
    Then Check "final" runs Operation "file.smoke-signal-read@1.0.0" on "expected signal" as Input "expectedSignal" and must establish "all declared work has been verified"
      """js
      fact.signal === fact.expectedSignal || fail("the signal is not ready")
      """
`;
    await fixture.initialize("live", parent);
    const operation = (
      await readFile(path.join(root, "assets/operations/file.smoke-signal-read.feature"), "utf8")
    ).replace("@operation:file.smoke-signal-read", "@operation:mission.signal-read");
    const source = (await readFile(path.join(root, "assets/procedures/09-runner-smoke.feature"), "utf8"))
      .replace("@procedure:runner-smoke", "@procedure:mission-live")
      .replace("file.smoke-signal-read@*", "mission.signal-read@1.0.0");
    const mission = {
      id: "first",
      definition: { kind: "inline", procedureSource: source, operationSources: [operation] },
      rootInputs: {},
    };
    const run = async (checkUri: string) => {
      const result = await execute(process.execPath, [path.join(skill, "scripts/run.js"), checkUri, "--json"], {
        cwd: directory,
        env: {
          ...process.env,
          TRUST_RPC_ENDPOINT: `${fixture.endpoint}/rpc`,
          TRUST_OTLP_ENDPOINT: `${fixture.endpoint}/v1/traces`,
        },
      });
      return JSON.parse(result.stdout) as { result: { status: string; qualification?: { verdict: string } } };
    };
    assert.equal((await fixture.read()).checks.find((check) => check.name === "final")?.actionable, false);
    await fixture.rpc("plan.declarations.replace", await fixture.declaration([mission]));
    const first = (await fixture.read()).invocations.find((invocation) => invocation.mission?.id === "first");
    assert.deepEqual(first?.mission, { collection: "work", id: "first" });
    assert.ok(first?.childPlan);
    const mcp = await fixture.mcp("trust_plan_read", { plan: first.childPlan });
    assert.ok(mcp.result && !mcp.result.isError);
    assert.match(JSON.stringify(mcp.result), /Modify the signal/);
    const child = await fixture.rpc<PlanView>("plan.read", { plan: first.childPlan });
    assert.ok(child.checks[0]);
    const completed = await run(child.checks[0].checkUri);
    assert.equal(completed.result.status, "COMPLETED");
    assert.equal(completed.result.qualification?.verdict, "VALIDATED");
    const finalCheck = (await fixture.read()).checks.find((check) => check.name === "final");
    assert.ok(finalCheck?.actionable);
    assert.equal((await run(finalCheck.checkUri)).result.qualification?.verdict, "VALIDATED");
    assert.equal((await fixture.read()).checks.find((check) => check.name === "final")?.state, "SATISFIED");
    const later = {
      ...mission,
      id: "later",
      definition: { ...mission.definition, procedureSource: source.replace('fixed as "ready"', 'fixed as "blocked"') },
    };
    await fixture.rpc("plan.declarations.replace", await fixture.declaration([mission, later]));
    const extended = await fixture.read();
    assert.equal(extended.checks.find((check) => check.name === "final")?.state, "OPEN");
    assert.equal(extended.checks.find((check) => check.name === "final")?.actionable, false);
    assert.equal((await fixture.rpc<PlanView>("plan.read", { plan: first.childPlan })).checks[0]?.state, "SATISFIED");
    const second = extended.invocations.find((invocation) => invocation.mission?.id === "later");
    assert.ok(second?.childPlan);
    const secondView = await fixture.rpc<PlanView>("plan.read", { plan: second.childPlan });
    assert.ok(secondView.checks[0]);
    assert.equal((await run(secondView.checks[0].checkUri)).result.qualification?.verdict, "NOT_VALIDATED");
    const blocked = (await fixture.rpc<PlanView>("plan.read", { plan: second.childPlan })).checks[0];
    assert.ok(blocked?.escalatable && blocked.attemptHandle);
    await fixture.rpc("check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: blocked.checkUri,
      attemptHandle: blocked.attemptHandle,
      blockingReason: "The observed signal does not satisfy the declared mission.",
      forbiddenFurtherAction: "Modify the signal or qualification criteria to manufacture success.",
    });
    assert.ok((await fixture.read()).descendantEscalations.some((escalation) => escalation.plan === second.childPlan));
    assert.equal((await fixture.read()).checks.find((check) => check.name === "final")?.state, "OPEN");
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an inline Procedure combines catalog Operations and a pinned published child through real prerequisites", {
  timeout: 40_000,
}, async () => {
  const fixture = await setup();
  try {
    await fixture.initialize();
    const source =
      childSource("mission-composed") +
      `
  @scenario:nested
  Scenario: Execute the reusable Procedure after observation
    Given scenario "observe" is validated
    Then Invocation "reusable" runs Procedure "mission-kernel@^1.0.0" on "repository" as Input "repository" and must establish "the reusable work completed"
  @scenario:final
  Scenario: Verify the complete composition
    Given scenario "nested" is validated
    Then Check "final" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "the composed mission completed"
      """js
      fact.workingTree === "clean" || fail("the repository is dirty")
      """
`;
    await fixture.rpc("procedure.publish", { source: childSource("mission-specialist") });
    const kernel = `@trust-dsl:1 @procedure:mission-kernel @version:1.0.0
Feature: Compose two reusable specialists
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repositories. | Modify repository state. |
    And one reference "repository"
  @scenario:first
  Scenario: First specialist
    Then Invocation "first-specialist" runs Procedure "mission-published@^1.0.0" on "repository" as Input "repository" and must establish "first specialist complete"
  @scenario:second
  Scenario: Second specialist
    Given scenario "first" is validated
    Then Invocation "second-specialist" runs Procedure "mission-specialist@1.0.0" on "repository" as Input "repository" and must establish "second specialist complete"
`;
    await fixture.rpc("procedure.publish", { source: kernel });
    const mission = {
      id: "composed",
      definition: { kind: "inline", procedureSource: source, operationSources: [] },
      rootInputs: { repository: "composed-repository" },
    };
    const catalogBefore = await fixture.rpc("procedure.list", {});
    await fixture.rpc("plan.declarations.replace", await fixture.declaration([mission]));
    const rootView = await fixture.read();
    const childPlan = rootView.invocations[0]?.childPlan;
    assert.ok(childPlan);
    const initial = await fixture.rpc<PlanView>("plan.read", { plan: childPlan });
    assert.equal(initial.checks.length, 2);
    assert.ok(initial.checks.find((check) => check.name === "diagnostic")?.actionable);
    const final = initial.checks.find((check) => check.name === "final");
    assert.ok(final);
    assert.equal(final.actionable, false);
    assert.equal(initial.invocations[0]?.state, "WAITING");
    assert.equal(initial.invocations[0]?.childPlan, null);
    assert.deepEqual(await fixture.rpc("procedure.list", {}), catalogBefore);
    const refused = await fixture.rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: final.checkUri,
      attemptKey: "premature-composed-final",
    });
    assert.equal(refused.status, "REFUSED");
    await fixture.rpc("procedure.publish", { source: childSource("mission-published", "git.head-read", "1.1.0") });
    await fixture.rpc("procedure.publish", { source: kernel.replace("@version:1.0.0", "@version:1.1.0") });
    let sequence = 0;
    const qualify = async (plan: string, name: string) => {
      const view = await fixture.rpc<PlanView>("plan.read", { plan });
      const check = view.checks.find((candidate) => candidate.name === name);
      assert.ok(check?.actionable);
      const attempt: CheckAttemptAdmissionResult = await fixture.rpc("check.attempt.admit", {
        contract: "trust.check-admission-request@1",
        checkUri: check.checkUri,
        attemptKey: `composed-${++sequence}`,
      });
      assert.equal(attempt.status, "ADMITTED");
      assert.equal(attempt.operation.operation, "git.head-read");
      assert.equal(attempt.operation.version, "1.0.0");
      const observedAt = new Date().toISOString();
      await fixture.rpc("check.attempt.facts", {
        contract: "trust.fact-batch-request@1",
        attemptHandle: attempt.attemptHandle,
        attemptKey: attempt.attemptKey,
        executionId: attempt.executionId,
        checkUri: attempt.checkUri,
        recordedAt: observedAt,
        facts: [
          {
            kind: attempt.operation.operation,
            observedAt,
            values: { workingTree: "clean", headRevision: "composed-head" },
          },
        ],
      });
      const result = await fixture.rpc<CheckFinalizationResult>("check.attempt.finalize", {
        contract: "trust.attempt-finalization-request@1",
        attemptHandle: attempt.attemptHandle,
      });
      assert.equal(result.verdict, "VALIDATED");
    };
    await qualify(childPlan, "diagnostic");
    const afterObservation = await fixture.rpc<PlanView>("plan.read", { plan: childPlan });
    const grandchildPlan = afterObservation.invocations[0]?.childPlan;
    assert.ok(grandchildPlan);
    assert.equal(afterObservation.checks.find((check) => check.name === "final")?.actionable, false);
    const grandchild = await fixture.rpc<PlanView>("plan.read", { plan: grandchildPlan });
    assert.equal(grandchild.procedure, "mission-kernel");
    assert.equal(grandchild.procedureVersion, "1.0.0");
    assert.deepEqual(grandchild.rootInputs, { repository: "composed-repository" });
    await fixture.restart();
    assert.equal(
      (await fixture.rpc<PlanView>("plan.read", { plan: childPlan })).invocations[0]?.childPlan,
      grandchildPlan,
    );
    assert.equal((await fixture.rpc<PlanView>("plan.read", { plan: grandchildPlan })).procedureVersion, "1.0.0");
    const firstSpecialist = grandchild.invocations.find(
      (invocation) => invocation.name === "first-specialist",
    )?.childPlan;
    assert.ok(firstSpecialist);
    assert.equal(grandchild.invocations.find((invocation) => invocation.name === "second-specialist")?.childPlan, null);
    assert.equal((await fixture.rpc<PlanView>("plan.read", { plan: firstSpecialist })).procedureVersion, "1.0.0");
    await qualify(firstSpecialist, "diagnostic");
    const secondSpecialist = (await fixture.rpc<PlanView>("plan.read", { plan: grandchildPlan })).invocations.find(
      (invocation) => invocation.name === "second-specialist",
    )?.childPlan;
    assert.ok(secondSpecialist);
    await qualify(secondSpecialist, "diagnostic");
    await qualify(childPlan, "final");
    const completed = await fixture.rpc<PlanView>("plan.read", { plan: childPlan });
    assert.ok(completed.checks.every((check) => check.state === "SATISFIED"));
    assert.equal(completed.invocations[0]?.state, "SATISFIED");
    assert.equal((await fixture.read()).invocations[0]?.state, "SATISFIED");
    await fixture.restart();
    const restored = await fixture.rpc<PlanView>("plan.read", { plan: childPlan });
    assert.deepEqual(restored.invocations, completed.invocations);
    assert.ok(restored.checks.every((check) => check.state === "SATISFIED"));
    assert.doesNotMatch(JSON.stringify(await fixture.rpc("procedure.list", {})), /mission-composed/);
  } finally {
    await fixture.close();
  }
});
