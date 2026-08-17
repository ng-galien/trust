import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startPublicRuntime } from "./support/runtime-process.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const operationsDirectory = path.join(repositoryRoot, "assets/operations");

test("an Operation Trial runs through the packaged runner and streams its diagnostics", async () => {
  const runtime = await startPublicRuntime("trust-operation-trial-", {
    operationsDirectory,
    environments: { local: { workspaceRoot: path.dirname(repositoryRoot) } },
  });
  try {
    const started = await rpc(runtime.endpoint, "operation.trial.start", {
      operation: "git.head-read",
      version: "1.0.0",
      environment: "local",
      input: { project: path.basename(repositoryRoot) },
    }) as { trial: { id: string } };

    const stream = fetch(`${runtime.endpoint}/otlp/diagnostics/trials/${started.trial.id}/stream`)
      .then(async (response) => {
        assert.equal(response.status, 200);
        return response.text();
      });
    const trial = await waitForTrial(runtime.endpoint, started.trial.id);
    const streamText = await stream;

    assert.equal(trial.status, "succeeded");
    assert.equal((trial.outcome as { diagnosticsFailures?: number }).diagnosticsFailures, 0);
    const eventTypes = trial.events.map(({ type }) => type);
    assert.ok(eventTypes.includes("operation.start"));
    assert.ok(eventTypes.includes("step.start"));
    assert.ok(eventTypes.includes("step.end"));
    assert.ok(eventTypes.includes("operation.end"));
    assert.equal(eventTypes.at(-1), "trial.completed");
    assert.match(streamText, /event: operation\.start/);
    assert.match(streamText, /event: trial\.completed/);
    assert.match(streamText, /event: end/);

    const listed = await rpc(runtime.endpoint, "operation.trial.list", {}) as {
      trials: Array<{ id: string; operation: string; status: string }>;
    };
    assert.deepEqual(listed.trials.map(({ id, operation, status }) => [id, operation, status]), [
      [started.trial.id, "git.head-read", "succeeded"],
    ]);
    const filtered = await rpc(runtime.endpoint, "operation.trial.list", { operation: "git.head-read" }) as {
      trials: Array<{ id: string }>;
    };
    assert.deepEqual(filtered.trials.map(({ id }) => id), [started.trial.id]);
    assert.equal((await rpcEnvelope(runtime.endpoint, "operation.trial.list", { unexpected: true })).error?.code, -32_602);
    assert.equal((await rpcEnvelope(runtime.endpoint, "operation.trial.read", { trial: started.trial.id, after: "latest" })).error?.code, -32_602);
  } finally {
    await runtime.close();
  }
});

test("a timed-out Trial kills its process tree and still closes a full diagnostic stream", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "trust-operation-timeout-"));
  const pidFile = path.join(workspaceRoot, "stubborn.pid");
  const runtime = await startPublicRuntime("trust-operation-timeout-runtime-", {
    environments: { local: { workspaceRoot } },
    trialTimeoutMs: 500,
  });
  try {
    const source = stubbornOperation(pidFile);
    const started = await rpc(runtime.endpoint, "operation.trial.start", {
      source,
      environment: "local",
      input: {},
    }) as { trial: { id: string } };

    await waitForFile(pidFile);
    const response = await fetch(`${runtime.endpoint}/otlp/diagnostics/trials/${started.trial.id}/stream`);
    assert.equal(response.status, 200);
    const stream = response.text();
    await fillDiagnosticStream(runtime.endpoint, started.trial.id);
    const trial = await waitForTrial(runtime.endpoint, started.trial.id);

    assert.equal(trial.status, "aborted");
    assert.equal(trial.events.length, 5_000);
    assert.equal(trial.events.at(-1)?.type, "trial.completed");
    await waitUntilProcessStops(Number(await readFile(pidFile, "utf8")));

    const streamText = await stream;
    assert.match(streamText, /event: trial\.completed/);
    assert.match(streamText, /event: end/);
  } finally {
    await runtime.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("an operator can cancel a running Trial and its process tree", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "trust-operation-cancel-"));
  const pidFile = path.join(workspaceRoot, "stubborn.pid");
  const runtime = await startPublicRuntime("trust-operation-cancel-runtime-", {
    environments: { local: { workspaceRoot } },
    trialTimeoutMs: 30_000,
  });
  try {
    const started = await rpc(runtime.endpoint, "operation.trial.start", {
      source: stubbornOperation(pidFile),
      environment: "local",
      input: {},
    }) as { trial: { id: string } };

    await waitForFile(pidFile);
    const response = await fetch(`${runtime.endpoint}/otlp/diagnostics/trials/${started.trial.id}/stream`);
    assert.equal(response.status, 200);
    const stream = response.text();

    await rpc(runtime.endpoint, "operation.trial.cancel", { trial: started.trial.id });
    const trial = await waitForTrial(runtime.endpoint, started.trial.id);
    assert.equal(trial.status, "aborted");
    assert.equal(trial.events.at(-1)?.type, "trial.completed");
    await waitUntilProcessStops(Number(await readFile(pidFile, "utf8")));

    const streamText = await stream;
    assert.match(streamText, /Trial cancelled by the operator/);
    assert.match(streamText, /event: trial\.completed/);
    assert.match(streamText, /event: end/);
  } finally {
    await runtime.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

interface TrialView {
  readonly status: "starting" | "running" | "succeeded" | "failed" | "aborted";
  readonly outcome?: unknown;
  readonly events: Array<{ readonly type: string }>;
}

async function waitForTrial(endpoint: string, trial: string): Promise<TrialView> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await rpc(endpoint, "operation.trial.read", { trial }) as { trial: TrialView };
    if (result.trial.status !== "starting" && result.trial.status !== "running") return result.trial;
    await delay(25);
  }
  throw new Error(`Trial ${trial} did not finish`);
}

async function fillDiagnosticStream(endpoint: string, trial: string): Promise<void> {
  const logRecords = Array.from({ length: 5_100 }, (_, index) => ({
    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n + BigInt(index)),
    body: { stringValue: JSON.stringify({ text: `diagnostic-${index}` }) },
    attributes: [{ key: "event.name", value: { stringValue: "trust.trial.runner.log" } }],
  }));
  const response = await fetch(`${endpoint}/otlp/diagnostics/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceLogs: [{
        resource: { attributes: [{ key: "trust.trial.id", value: { stringValue: trial } }] },
        scopeLogs: [{ logRecords }],
      }],
    }),
  });
  assert.equal(response.status, 200);
}

function stubbornOperation(pidFile: string): string {
  const code = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`;
  return `# language: en
@trust-dsl:1 @operation:test.stubborn @version:1.0.0
Feature: Keep running until the Trial stops the process tree

  Background: Operation interface
    Given Environment
      | name          | type      |
      | workspaceRoot | directory |
    And Produced fields
      | field     | type    | cardinality | domain |
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

async function waitUntilProcessStops(pid: number): Promise<void> {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await delay(50);
  }
  assert.fail(`Process ${pid} survived the Trial timeout`);
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error(`Timed-out Operation did not write ${file}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}

async function rpcEnvelope(endpoint: string, method: string, params: unknown): Promise<{
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  }>;
}
