import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";
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
  const runnerBinRoot = await mkdtemp(path.join(tmpdir(), "trust-runner-bin-"));
  await symlink(await executableOnPath("git"), path.join(runnerBinRoot, "git"));
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
  await assert.rejects(
    execute(process.execPath, [
      path.join(skill, "scripts/run.js"),
      "trust://local/example@1.0.0/plan/scenario/check/action",
      "--path",
      `${runnerBinRoot}${delimiter}.`,
    ], { cwd: artifactRoot }),
    (error: unknown) => {
      assert.match(String((error as Error & { stderr?: unknown }).stderr ?? ""), /--path requires one absolute directory/);
      return true;
    },
  );
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
        "--path",
        runnerBinRoot,
      ],
      {
        cwd: artifactRoot,
        env: {
          ...process.env,
          PATH: "",
          TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
          TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
        },
      },
    );
    const output = JSON.parse(result.stdout) as {
      result: {
        status: string;
        actionOutcome: {
          head: { exitCode: number; stdout: string; stderr: string };
          status: { exitCode: number; stdout: string; stderr: string };
        };
        qualification: { verdict: string; reasonCode: string };
      };
      next: { action: string };
    };
    assert.equal(output.result.status, "COMPLETED");
    assert.equal(output.result.qualification.verdict, "VALIDATED");
    assert.equal(output.result.qualification.reasonCode, "check-qualified");
    assert.equal(output.result.actionOutcome.head.exitCode, 0);
    assert.equal(output.result.actionOutcome.head.stdout.trim(), revision);
    assert.equal(output.result.actionOutcome.status.exitCode, 0);
    assert.match(output.result.actionOutcome.status.stdout, /untracked\.txt/);
    assert.equal(output.next.action, "COMPLETE");

    // A structured Runner result is authoritative and exits successfully regardless of its
    // checklist outcome. Process failures are reserved for invalid invocation or technical errors.
    const refusedReplay = await execute(
      process.execPath,
      [path.join(skill, "scripts/run.js"), checkUris[0]!, "--json", "--path", runnerBinRoot],
      {
        cwd: artifactRoot,
        env: {
          ...process.env,
          PATH: "",
          TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
          TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
        },
      },
    );
    const refusedOutput = JSON.parse(refusedReplay.stdout) as {
      result: { status: string; reasonCode: string };
      next: { action: string };
    };
    assert.equal(refusedOutput.result.status, "REFUSED");
    assert.equal(refusedOutput.result.reasonCode, "check-not-actionable");
    assert.equal(refusedOutput.next.action, "READ_PLAN");

    await rm(path.join(project, "untracked.txt"));
    const negativeEngagement = await mcpTool(runtime.endpoint, "trust_plan_engage", {
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "runner-git-status-not-validated",
      environment: "local",
      rootInputs: { repository: projectName },
    });
    const negativeCheckUri = uniqueUris(negativeEngagement)[0];
    assert.ok(negativeCheckUri);
    const negativeResult = await execute(
      process.execPath,
      [path.join(skill, "scripts/run.js"), negativeCheckUri, "--json", "--path", runnerBinRoot],
      {
        cwd: artifactRoot,
        env: {
          ...process.env,
          PATH: "",
          TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
          TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
        },
      },
    );
    const negativeOutput = JSON.parse(negativeResult.stdout) as {
      result: { status: string; qualification: { verdict: string; reasonCode: string } };
      next: {
        action: string;
        checks: readonly { name: string; successReason: string; checkUri: string; actionScope: unknown }[];
      };
    };
    assert.equal(negativeOutput.result.status, "COMPLETED");
    assert.equal(negativeOutput.result.qualification.verdict, "NOT_VALIDATED");
    assert.equal(negativeOutput.result.qualification.reasonCode, "qualification-not-satisfied");
    assert.deepEqual(negativeOutput.next, {
      action: "RETRY_OR_ESCALATE",
      checks: [{
        name: "repository status",
        successReason: "the repository has local changes",
        checkUri: negativeCheckUri,
        actionScope: {
          authorized: [
            "Read the declared repository state.",
            "Read Git metadata required to observe this Check.",
          ],
          forbidden: [
            "Modify the repository or its environment to obtain the expected state.",
            "Change repository files while observing repository status.",
          ],
        },
      }],
    });

    const textEngagement = await mcpTool(runtime.endpoint, "trust_plan_engage", {
      procedure: "git-status",
      procedureVersion: "2.0.0",
      plan: "runner-git-status-text",
      environment: "local",
      rootInputs: { repository: projectName },
    });
    const textCheckUri = uniqueUris(textEngagement)[0];
    assert.ok(textCheckUri);
    const textResult = await execute(
      process.execPath,
      [path.join(skill, "scripts/run.js"), textCheckUri, "--path", runnerBinRoot],
      {
        cwd: artifactRoot,
        env: {
          ...process.env,
          PATH: "",
          TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
          TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
        },
      },
    );
    assert.match(textResult.stdout, /Next: RETRY_OR_ESCALATE/);
    assert.match(textResult.stdout, /Authorized scope:\n  - Read the declared repository state\.\n  - Read Git metadata required to observe this Check\./);
    assert.match(textResult.stdout, /Forbidden scope:\n  - Modify the repository or its environment to obtain the expected state\.\n  - Change repository files while observing repository status\./);

    await writeFile(path.join(project, "untracked.txt"), "dirty\n", "utf8");
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
        PATH: "",
        TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
        TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
      },
      runnerBinRoot,
    );
    assert.equal(mcp.initialize.result?.serverInfo?.name, "trust-runner");
    assert.equal(mcp.tools.result?.tools?.[0]?.name, "trust_check_run");
    const mcpText = mcp.call.result?.content?.find(({ type }) => type === "text")?.text;
    assert.equal(typeof mcpText, "string");
    const mcpResult = JSON.parse(mcpText!) as {
      result: { status: string; qualification: { verdict: string } };
      next: { action: string };
    };
    assert.equal(mcpResult.result.status, "COMPLETED");
    assert.equal(mcpResult.result.qualification.verdict, "VALIDATED");
    assert.equal(mcpResult.next.action, "COMPLETE");

    const refusedMcp = await runMcpStdio(
      path.join(skill, "scripts/mcp-stdio.js"),
      mcpCheckUri,
      artifactRoot,
      {
        ...process.env,
        PATH: "",
        TRUST_RPC_ENDPOINT: `${runtime.endpoint}/rpc`,
        TRUST_OTLP_ENDPOINT: `${runtime.endpoint}/v1/traces`,
      },
      runnerBinRoot,
    );
    assert.notEqual(refusedMcp.call.result?.isError, true);
    const refusedMcpText = refusedMcp.call.result?.content?.find(({ type }) => type === "text")?.text;
    assert.equal(typeof refusedMcpText, "string");
    assert.deepEqual(JSON.parse(refusedMcpText!), {
      checkUri: mcpCheckUri,
      result: {
        status: "REFUSED",
        reasonCode: "check-not-actionable",
        reason: "The Check is already satisfied",
      },
      next: { action: "READ_PLAN" },
    });
  } finally {
    await runtime.close();
    await Promise.all([
      rm(project, { recursive: true, force: true }),
      rm(artifactRoot, { recursive: true, force: true }),
      rm(runnerBinRoot, { recursive: true, force: true }),
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
    readonly isError?: boolean;
  };
}

async function runMcpStdio(
  entry: string,
  checkUri: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  additionalPath: string,
): Promise<{
  readonly initialize: McpStdioResponse;
  readonly tools: McpStdioResponse;
  readonly call: McpStdioResponse;
}> {
  const child = spawn(process.execPath, [entry, "--path", additionalPath], { cwd, env, stdio: "pipe" });
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

async function executableOnPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`${name} is not available on PATH`);
}
