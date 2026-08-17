import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startPublicRuntime } from "./support/runtime-process.js";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

test("the packaged TRUST Skill executes the git-status Check", async () => {
  const projectsRoot = await mkdtemp(path.join(tmpdir(), "trust-runner-git-"));
  const projectName = "repository";
  const project = path.join(projectsRoot, projectName);
  await mkdir(project);
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "trust-skill-artifact-"));
  const skill = path.join(artifactRoot, "trust");
  await execute(process.execPath, [
    path.join(repositoryRoot, "packages/trust-runner/scripts/package-skill.ts"),
    "--output",
    skill,
  ], { cwd: repositoryRoot });
  await Promise.all([
    access(path.join(skill, "SKILL.md")),
    access(path.join(skill, "agents/openai.yaml")),
    access(path.join(skill, "references/results.md")),
    access(path.join(skill, "scripts/run.js")),
    access(path.join(skill, "scripts/mcp-stdio.js")),
  ]);
  await execute("git", ["init", "-q"], { cwd: project });
  await writeFile(path.join(project, "tracked.txt"), "baseline\n", "utf8");
  await execute("git", ["add", "tracked.txt"], { cwd: project });
  await execute("git", [
    "-c", "user.name=TRUST Acceptance",
    "-c", "user.email=trust@example.invalid",
    "commit", "-qm", "baseline",
  ], { cwd: project });
  const revision = (await execute("git", ["rev-parse", "HEAD"], { cwd: project })).stdout.trim();
  await writeFile(path.join(project, "untracked.txt"), "dirty\n", "utf8");

  const runtime = await startPublicRuntime("trust-runner-runtime-", {
    operationsDirectory: path.join(repositoryRoot, "assets/operations"),
    environments: { local: { workspaceRoot: projectsRoot } },
  });
  try {
    const procedure = await readText(path.join(repositoryRoot, "assets/procedures/00-git-status.feature"));
    await rpc(runtime.endpoint, "procedure.publish", {
      source: procedure,
      sourceName: "00-git-status.feature",
    });
    const engagement = await mcpTool(runtime.endpoint, "trust_plan_engage", {
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "runner-git-status",
      environment: "local",
      rootInputs: { repository: projectName },
    });
    assert.match(engagement, /ACTIONABLE CHECKS\n- repository status/);
    const checkUris = uniqueUris(engagement);
    assert.equal(checkUris.length, 1);
    const plan = await mcpTool(runtime.endpoint, "trust_plan_read", {
      checkUri: checkUris[0],
    });
    assert.match(plan, /NEXT\nRun this Check with the TRUST Skill/);
    assert.ok(plan.includes(`Target: repository (one) = ${JSON.stringify(projectName)}`));
    assert.ok(plan.includes(`- project = ${JSON.stringify(projectName)}`));
    assert.match(plan, /Check URI: trust:\/\//);
    assert.match(plan, /Operation: git\.head-read/);
    assert.match(plan, /\[OPEN, ACTIONABLE\] repository status/);
    assert.doesNotMatch(plan, /Latest accepted attempt reason: none/);

    const result = await execute(
      process.execPath,
      [
        path.join(skill, "scripts/run.js"),
        checkUris[0]!,
        "--json",
      ],
      {
        cwd: artifactRoot,
        env: {
          ...process.env,
          TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
          TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
        },
      },
    );
    const output = JSON.parse(result.stdout) as {
      status: string;
      verdict: string;
      reasonCode: string;
      actionOutcome: {
        head: { exitCode: number; stdout: string; stderr: string };
        status: { exitCode: number; stdout: string; stderr: string };
      };
    };
    assert.equal(output.status, "COMPLETED");
    assert.equal(output.verdict, "VALIDATED");
    assert.equal(output.reasonCode, "check-qualified");
    assert.equal(output.actionOutcome.head.exitCode, 0);
    assert.equal(output.actionOutcome.head.stdout.trim(), revision);
    assert.equal(output.actionOutcome.status.exitCode, 0);
    assert.match(output.actionOutcome.status.stdout, /untracked\.txt/);

    const mcpEngagement = await mcpTool(runtime.endpoint, "trust_plan_engage", {
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "runner-git-status-mcp",
      environment: "local",
      rootInputs: { repository: projectName },
    });
    const mcpCheckUri = uniqueUris(mcpEngagement)[0];
    assert.ok(mcpCheckUri);
    const mcp = await runMcpStdio(
      path.join(skill, "scripts/mcp-stdio.js"),
      mcpCheckUri,
      artifactRoot,
      {
        ...process.env,
        TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
        TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
      },
    );
    assert.equal(mcp.initialize.result?.serverInfo?.name, "trust-runner");
    assert.equal(mcp.tools.result?.tools?.[0]?.name, "trust_check_run");
    const mcpText = mcp.call.result?.content?.find(({ type }) => type === "text")?.text;
    assert.equal(typeof mcpText, "string");
    const mcpResult = JSON.parse(mcpText!) as { status: string; verdict: string };
    assert.equal(mcpResult.status, "COMPLETED");
    assert.equal(mcpResult.verdict, "VALIDATED");
  } finally {
    await runtime.close();
    await Promise.all([
      rm(project, { recursive: true, force: true }),
      rm(artifactRoot, { recursive: true, force: true }),
    ]);
  }
});

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  const payload = await response.json() as {
    result?: unknown;
    error?: { message?: string };
  };
  if (payload.error !== undefined) throw new Error(payload.error.message ?? `${method} failed`);
  return payload.result;
}

interface McpStdioResponse {
  readonly result?: {
    readonly serverInfo?: { readonly name?: string };
    readonly tools?: readonly { readonly name?: string }[];
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
}

async function runMcpStdio(
  entry: string,
  checkUri: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  readonly initialize: McpStdioResponse;
  readonly tools: McpStdioResponse;
  readonly call: McpStdioResponse;
}> {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: "pipe" });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(`${[
    {
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "trust-acceptance", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "trust_check_run", arguments: { checkUri } },
    },
  ].map((message) => JSON.stringify(message)).join("\n")}\n`);
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(code, 0, `MCP STDIO exited with signal ${String(signal)}: ${stderr}`);
  assert.equal(stderr, "");
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line) as McpStdioResponse);
  assert.equal(responses.length, 3);
  return {
    initialize: responses[0]!,
    tools: responses[1]!,
    call: responses[2]!,
  };
}

async function mcpTool(
  endpoint: string,
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string> {
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json() as {
    result?: { content?: readonly { type?: string; text?: string }[]; isError?: boolean };
    error?: unknown;
  };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  assert.notEqual(envelope.result?.isError, true, envelope.result?.content?.[0]?.text);
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return text!;
}

function uniqueUris(text: string): string[] {
  return [...new Set([...text.matchAll(/trust:\/\/[^\s]+/g)].map(([uri]) => uri))];
}

async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}
