import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("the generic runner executes the git-status Check without a Git skill", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "trust-runner-git-"));
  await execute("git", ["init", "-q"], { cwd: project });
  await writeFile(path.join(project, "tracked.txt"), "baseline\n", "utf8");
  await execute("git", ["add", "tracked.txt"], { cwd: project });
  await execute("git", [
    "-c", "user.name=TRUST Acceptance",
    "-c", "user.email=trust@example.invalid",
    "commit", "-qm", "baseline",
  ], { cwd: project });
  await writeFile(path.join(project, "untracked.txt"), "dirty\n", "utf8");

  const runtime = await startPublicRuntime("trust-runner-runtime-", {
    skillPolicy: "local",
    operationsDirectory: path.join(repositoryRoot, "assets/operations"),
    executionEnvironments: { local: { projectRoot: project } },
  });
  try {
    const procedure = await readText(path.join(repositoryRoot, "assets/procedures/00-git-status.feature"));
    await rpc(runtime.endpoint, "procedure.definition.publish", {
      source: procedure,
      sourceName: "00-git-status.feature",
    });
    const engagement = await rpc(runtime.endpoint, "plan.engage", {
      contract: "trust.plan-engagement-request@1",
      procedure: "git-status",
      procedureVersion: "1.0.1",
      plan: "runner-git-status",
      environment: "local",
      rootInputs: { repository: project },
    }) as { checkUris: string[] };
    assert.equal(engagement.checkUris.length, 1);

    const result = await execute(
      "bun",
      [
        path.join(repositoryRoot, "packages/trust-runner/scripts/run.ts"),
        engagement.checkUris[0]!,
        "--json",
      ],
      {
        cwd: repositoryRoot,
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
    };
    assert.equal(output.status, "COMPLETED");
    assert.equal(output.verdict, "VALIDATED");
    assert.equal(output.reasonCode, "check-qualified");
  } finally {
    await runtime.close();
    await rm(project, { recursive: true, force: true });
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

async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}
