import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startPublicRuntime } from "./support/runtime-process.js";

const expectedAuthoringTools = [
  "trust_operation_list",
  "trust_operation_read",
  "trust_operation_compile",
  "trust_operation_save",
  "trust_operation_remove",
  "trust_operation_simulate",
  "trust_operation_environment_list",
  "trust_operation_trial_start",
  "trust_operation_trial_list",
  "trust_operation_trial_read",
  "trust_operation_trial_cancel",
  "trust_procedure_list",
  "trust_published_procedure_read",
  "trust_procedure_compile",
  "trust_procedure_publish",
] as const;

test("MCP exposes the UI Operation and Procedure authoring lifecycle through runtime authorities", async () => {
  const operationsDirectory = await mkdtemp(path.join(tmpdir(), "trust-mcp-operations-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "trust-mcp-workspace-"));
  const runtime = await startPublicRuntime("trust-mcp-authoring-", {
    operationsDirectory,
    environments: { local: { workspaceRoot } },
    trialTimeoutMs: 30_000,
  });
  let activeTrial: string | undefined;
  try {
    const listedTools = await mcpRequest(runtime.endpoint, "tools/list", {});
    const tools = (listedTools.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    for (const name of expectedAuthoringTools) {
      assert.ok(tools.some((tool) => tool.name === name), `${name} is missing from tools/list`);
    }
    assert.ok(tools.some((tool) => tool.name === "trust_procedure_read"), "the Check-scoped Procedure reader must remain available");

    const source = operationSource("test.mcp-authoring");
    assert.match(await mcpTool(runtime.endpoint, "trust_operation_compile", { source, sourceName: "draft.feature" }), /OPERATION COMPILED\nOperation: test\.mcp-authoring@1\.0\.0/);
    const closedSchema = await mcpRequest(runtime.endpoint, "tools/call", {
      name: "trust_operation_compile",
      arguments: { source, unexpected: true },
    });
    assert.equal(closedSchema.error?.code, -32_602);

    assert.match(await mcpTool(runtime.endpoint, "trust_operation_save", {
      source,
      sourceName: "test.mcp-authoring.feature",
    }), /OPERATION SAVED/);
    assert.match(await mcpTool(runtime.endpoint, "trust_operation_list", {}), /test\.mcp-authoring@1\.0\.0/);
    assert.match(await mcpTool(runtime.endpoint, "trust_operation_read", {
      operation: "test.mcp-authoring",
      version: "1.0.0",
    }), /SOURCE\n# language: en/);

    const simulation = await mcpTool(runtime.endpoint, "trust_operation_simulate", {
      source,
      input: { request: "run" },
      environment: { workspaceRoot },
      steps: { wait: { exitCode: 0, stdout: "", stderr: "" } },
    });
    assert.match(simulation, /OPERATION SIMULATED/);
    assert.match(simulation, /"completed": "yes"/);

    const environments = await mcpTool(runtime.endpoint, "trust_operation_environment_list", {
      operation: "test.mcp-authoring",
      version: "1.0.0",
    });
    assert.match(environments, /- local: compatible/);
    const invalidEnvironmentScope = await mcpRequest(runtime.endpoint, "tools/call", {
      name: "trust_operation_environment_list",
      arguments: { operation: "test.mcp-authoring", source },
    });
    assert.equal(invalidEnvironmentScope.error?.code, -32_602);

    const procedure = procedureSource();
    assert.match(await mcpTool(runtime.endpoint, "trust_procedure_compile", {
      source: procedure,
      sourceName: "draft-procedure.feature",
    }), /PROCEDURE COMPILED\nProcedure: test-mcp-procedure@1\.0\.0/);
    assert.match(await mcpTool(runtime.endpoint, "trust_procedure_publish", {
      source: procedure,
      sourceName: "test.mcp-procedure.feature",
    }), /PROCEDURE PUBLISHED/);
    assert.match(await mcpTool(runtime.endpoint, "trust_procedure_list", {}), /test-mcp-procedure@1\.0\.0/);
    const published = await mcpTool(runtime.endpoint, "trust_published_procedure_read", {
      procedure: "test-mcp-procedure",
      version: "1.0.0",
    });
    assert.match(published, /Published by: mcp-agent/);
    assert.match(published, /SOURCE\n# language: en/);

    const removable = operationSource("test.mcp-removable");
    await mcpTool(runtime.endpoint, "trust_operation_save", {
      source: removable,
      sourceName: "test.mcp-removable.feature",
    });
    assert.match(await mcpTool(runtime.endpoint, "trust_operation_remove", {
      operation: "test.mcp-removable",
      version: "1.0.0",
    }), /OPERATION REMOVED/);
    assert.doesNotMatch(await mcpTool(runtime.endpoint, "trust_operation_list", {}), /test\.mcp-removable/);

    const invalidTrialAlternative = await mcpRequest(runtime.endpoint, "tools/call", {
      name: "trust_operation_trial_start",
      arguments: {
        operation: "test.mcp-authoring",
        version: "1.0.0",
        source,
        environment: "local",
        input: { request: "run" },
      },
    });
    assert.equal(invalidTrialAlternative.error?.code, -32_602);

    const started = await mcpTool(runtime.endpoint, "trust_operation_trial_start", {
      operation: "test.mcp-authoring",
      version: "1.0.0",
      environment: "local",
      input: { request: "run" },
    });
    const trial = /^Trial: (.+)$/m.exec(started)?.[1];
    assert.ok(trial);
    activeTrial = trial;
    assert.match(started, /Started by: mcp-agent/);
    assert.match(await mcpTool(runtime.endpoint, "trust_operation_trial_list", {
      operation: "test.mcp-authoring",
    }), new RegExp(`Trial: ${escapeRegExp(trial)}`));
    assert.match(await mcpTool(runtime.endpoint, "trust_operation_trial_read", { trial, after: 0 }), /Status: (starting|running)/);
    assert.match(await mcpTool(runtime.endpoint, "trust_operation_trial_cancel", { trial }), /OPERATION TRIAL CANCELLED/);
    const completed = await waitForTrial(runtime.endpoint, trial);
    assert.match(completed, /Status: aborted/);
    assert.match(completed, /trial\.completed/);
    activeTrial = undefined;
  } finally {
    if (activeTrial !== undefined) {
      await mcpTool(runtime.endpoint, "trust_operation_trial_cancel", { trial: activeTrial }).catch(() => undefined);
      await waitForTrial(runtime.endpoint, activeTrial).catch(() => undefined);
    }
    await runtime.close();
    await rm(operationsDirectory, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function operationSource(operation: string): string {
  const code = "setInterval(() => {}, 1000)";
  return `# language: en
@trust-dsl:1 @operation:${operation} @version:1.0.0
Feature: Exercise MCP authoring

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Input
      | input   | type   | cardinality |
      | request | string | one         |
    And Produced fields
      | field     | type   | cardinality | domain |
      | completed | string | one         | any    |

  Scenario: Run
    When Shell "wait" runs "${process.execPath}" with cwd from Environment "workspaceRoot"
      | argument | source  |
      | -e       | literal |
      | ${code} | literal |
    Then Produce with JSONata
      """
      { "completed": "yes" }
      """
`;
}

function procedureSource(): string {
  return `# language: en
@trust-dsl:1 @procedure:test-mcp-procedure @version:1.0.0
Feature: Exercise MCP Procedure authoring

  Background: Plan context
    Given Procedure scope
      | check      | authorized                  | forbidden                         |
      | all        | Run the declared Operation. | Change the Operation definition.  |
      | completion | Observe its completion.     | Manufacture a successful result.  |
    And one string "request" fixed as "run"

  @scenario:execute
  Scenario: Execute the Operation
    Then Check "completion" runs Operation "test.mcp-authoring" on "request" as Input "request" and must establish "the Operation completed"
      """js
      fact.completed === "yes" || fail("the Operation did not complete")
      """
`;
}

async function waitForTrial(endpoint: string, trial: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await mcpTool(endpoint, "trust_operation_trial_read", { trial, after: 0 });
    if (!/Status: (starting|running)/.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Trial ${trial} did not complete`);
}

async function mcpTool(endpoint: string, name: string, args: Readonly<Record<string, unknown>>): Promise<string> {
  const envelope = await mcpRequest(endpoint, "tools/call", { name, arguments: args });
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  const result = envelope.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return text!;
}

async function mcpRequest(
  endpoint: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ result?: unknown; error?: { code: number; message: string } }>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
