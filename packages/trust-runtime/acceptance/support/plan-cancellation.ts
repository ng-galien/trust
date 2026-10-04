import assert from "node:assert/strict";
import type { CheckAttemptAdmissionResult, CheckFinalizationResult, PlanView } from "@trust/extension-sdk";

/** A leaf Procedure: one Check that a clean repository validates and a dirty one does not. */
export const leafSource = `@trust-dsl:1 @procedure:pcn-leaf @version:1.0.0
Feature: Observe one delegated repository
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the repository. | Modify the repository or qualification criteria. |
    And one reference "repository"
  @scenario:observe
  Scenario: Observe
    Then Check "diagnostic" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "the diagnostic is available"
      """js
      fact.workingTree === "clean" || fail("the repository is dirty")
      """
`;

/** A middle Procedure: its own Check and a static invocation of the leaf, so a mission has a descendant. */
export const branchSource = `@trust-dsl:1 @procedure:pcn-branch @version:1.0.0
Feature: Inspect a repository and delegate its leaf
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Read the repository. | Modify the repository or qualification criteria. |
    And one reference "repository"
  @scenario:inspect
  Scenario: Inspect
    Then Check "inspection" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "the inspection is available"
      """js
      fact.workingTree === "clean" || fail("the repository is dirty")
      """
  @scenario:delegate
  Scenario: Delegate the leaf
    Then Invocation "leaf" runs Procedure "pcn-leaf@1.0.0" on "repository" as Input "repository" and must establish "the leaf is observed"
`;

/** A root Procedure: its own Check and a mission collection declared by the agent. */
export const rootSource = `@trust-dsl:1 @procedure:pcn-root @version:1.0.0
Feature: Coordinate declared repository work
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repositories. | Change external state. |
    And one reference "repository"
    And missions "work" declared by agent
  @scenario:survey
  Scenario: Survey
    Then Check "survey" runs Operation "git.head-read@1.0.0" on "repository" as Input "project" and must establish "the survey is available"
      """js
      fact.workingTree === "clean" || fail("the repository is dirty")
      """
  @scenario:work
  Scenario: Execute declared work
    Then Invocation "execute-work" runs each declared Procedure in "work" and must establish "declared work completed"
`;

export interface RpcFailure {
  readonly code: number;
  readonly message: string;
  readonly data?: { readonly reason?: string; readonly message?: string };
}

export interface McpToolResult {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
}

/** RPC, MCP and dry-run Check helpers bound to one disposable runtime endpoint. */
export function cancellationClient(endpoint: string) {
  const envelope = async <T>(method: string, params: unknown): Promise<{ result?: T; error?: RpcFailure }> => {
    const response = await fetch(`${endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ result?: T; error?: RpcFailure }>;
  };
  const rpc = async <T = unknown>(method: string, params: unknown): Promise<T> => {
    const body = await envelope<T>(method, params);
    assert.equal(body.error, undefined, `${method}: ${JSON.stringify(body.error)}`);
    return body.result as T;
  };
  const refused = async (method: string, params: unknown): Promise<RpcFailure> => {
    const body = await envelope(method, params);
    assert.ok(body.error, `${method} must be refused: ${JSON.stringify(body.result)}`);
    return body.error;
  };
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { result?: McpToolResult; error?: { code: number; message: string } };
  };
  const mcpText = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const body = await mcp(name, args);
    assert.equal(body.error, undefined, `${name}: ${JSON.stringify(body.error)}`);
    assert.notEqual(body.result?.isError, true, `${name}: ${body.result?.content[0]?.text}`);
    return body.result?.content.map((item) => item.text).join("\n") ?? "";
  };
  const read = (plan: string) => rpc<PlanView>("plan.read", { plan });

  const publish = async () => {
    await rpc("environment.save", { environment: "local", values: {} });
    for (const source of [leafSource, branchSource, rootSource]) await rpc("procedure.publish", { source });
  };
  const engage = (plan: string, procedure: "pcn-root" | "pcn-branch" | "pcn-leaf") =>
    rpc("plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure,
      procedureVersion: "1.0.0",
      plan,
      mode: "dry-run",
      environment: "local",
      rootInputs: { repository: `${plan}-repository` },
    });
  /** A root Plan whose "work" collection holds one mission; returns the mission child and its leaf. */
  const composition = async (plan: string) => {
    await engage(plan, "pcn-root");
    await rpc("plan.declarations.replace", {
      contract: "trust.plan-declaration-replacement-request@1",
      plan,
      expectedRevision: (await read(plan)).revision,
      declarations: {},
      missionDeclarations: {
        work: [
          {
            id: "branch",
            definition: { kind: "published", reference: "pcn-branch@1.0.0" },
            rootInputs: { repository: `${plan}-branch-repository` },
          },
        ],
      },
    });
    const child = (await read(plan)).invocations.find((invocation) => invocation.mission?.id === "branch")?.childPlan;
    assert.ok(child, "the mission has a child Plan");
    const leaf = (await read(child)).invocations.find((invocation) => invocation.name === "leaf")?.childPlan;
    assert.ok(leaf, "the mission child Plan has a leaf child Plan");
    return { child, leaf };
  };
  const checkUri = async (plan: string, name: string) => {
    const check = (await read(plan)).checks.find((candidate) => candidate.name === name);
    assert.ok(check, `Plan ${plan} has Check ${name}`);
    return check.checkUri;
  };
  const admit = (uri: string, attemptKey: string) =>
    rpc<CheckAttemptAdmissionResult>("check.attempt.admit", {
      contract: "trust.check-admission-request@1",
      checkUri: uri,
      attemptKey,
    });
  /** Admit, submit one operator Fact and finalize: a clean repository validates the Check, a dirty one does not. */
  const qualify = async (uri: string, attemptKey: string, clean: boolean) => {
    const admitted = await admit(uri, attemptKey);
    assert.equal(admitted.status, "ADMITTED", JSON.stringify(admitted));
    const observedAt = new Date().toISOString();
    await rpc("check.attempt.facts", {
      contract: "trust.fact-batch-request@1",
      attemptHandle: admitted.attemptHandle,
      attemptKey: admitted.attemptKey,
      executionId: admitted.executionId,
      checkUri: admitted.checkUri,
      recordedAt: observedAt,
      facts: [
        {
          kind: admitted.operation.operation,
          observedAt,
          values: { workingTree: clean ? "clean" : "dirty", headRevision: "head" },
        },
      ],
    });
    const finalized = await rpc<CheckFinalizationResult>("check.attempt.finalize", {
      contract: "trust.attempt-finalization-request@1",
      attemptHandle: admitted.attemptHandle,
    });
    assert.equal(finalized.verdict, clean ? "VALIDATED" : "NOT_VALIDATED");
    return admitted;
  };
  const escalate = async (uri: string, attemptHandle: string) =>
    rpc<{ status: string }>("check.escalate", {
      contract: "trust.check-escalation-request@1",
      checkUri: uri,
      attemptHandle,
      blockingReason: "The repository stays dirty within the authorized scope.",
      forbiddenFurtherAction: "Clean the repository outside the declared scope.",
    });
  return {
    envelope,
    rpc,
    refused,
    mcp,
    mcpText,
    read,
    publish,
    engage,
    composition,
    checkUri,
    admit,
    qualify,
    escalate,
  };
}
