import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startPublicRuntime } from "./support/runtime-process.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const operationsDirectory = path.join(repositoryRoot, "assets/operations");

test("environments and credential references persist without exposing credential values", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "trust-environment-configuration-"));
  const databasePath = path.join(dataDirectory, "trust.sqlite");
  const credentialValue = "acceptance-secret-that-must-not-be-returned";

  try {
    const first = await startPublicRuntime("trust-environment-first-", {
      databasePath,
      skillPolicy: "local",
      operationsDirectory,
    });
    try {
      const savedEnvironment = await rpc(first.endpoint, "environment.save", {
        environment: "local",
        values: { workspaceRoot: path.dirname(repositoryRoot) },
      });
      assert.deepEqual(savedEnvironment, {
        contract: "trust.environment@1",
        environment: {
          name: "local",
          values: { workspaceRoot: path.dirname(repositoryRoot) },
        },
      });

      const savedCredential = await rpc(first.endpoint, "credential.save", {
        environment: "local",
        name: "gitToken",
        value: credentialValue,
      });
      assert.deepEqual(savedCredential, {
        contract: "trust.credential@1",
        credential: { environment: "local", name: "gitToken" },
      });
      assert.equal(JSON.stringify(savedCredential).includes(credentialValue), false);
    } finally {
      await first.close();
    }

    const second = await startPublicRuntime("trust-environment-second-", {
      databasePath,
      skillPolicy: "local",
      operationsDirectory,
    });
    try {
      const environments = await rpc(second.endpoint, "environment.list", {});
      assert.deepEqual(environments, {
        contract: "trust.environment-catalog@1",
        environments: [{
          name: "local",
          values: { workspaceRoot: path.dirname(repositoryRoot) },
        }],
      });

      const credentials = await rpc(second.endpoint, "credential.list", { environment: "local" });
      assert.deepEqual(credentials, {
        contract: "trust.credential-catalog@1",
        credentials: [{ environment: "local", name: "gitToken" }],
      });
      assert.equal(JSON.stringify(credentials).includes(credentialValue), false);

      const started = await rpc(second.endpoint, "operation.trial.start", {
        operation: "git.head-read",
        version: "1.0.0",
        environment: "local",
        input: { project: path.basename(repositoryRoot) },
      }) as { trial: { id: string } };
      assert.equal((await waitForTrial(second.endpoint, started.trial.id)).status, "succeeded");

      const invalid = await rpcEnvelope(second.endpoint, "environment.save", {
        environment: "NOT CANONICAL",
        values: { workspaceRoot: path.dirname(repositoryRoot) },
      });
      assert.equal(invalid.error?.code, -32_602);
      assert.equal(invalid.error?.data?.contract, "trust.environment-configuration-error@1");

      assert.deepEqual(await rpc(second.endpoint, "environment.remove", { environment: "local" }), {
        contract: "trust.environment-removal@1",
        environment: "local",
        removed: true,
      });
      assert.deepEqual(await rpc(second.endpoint, "credential.list", { environment: "local" }), {
        contract: "trust.credential-catalog@1",
        credentials: [],
      });
    } finally {
      await second.close();
    }

    const third = await startPublicRuntime("trust-environment-third-", {
      databasePath,
      skillPolicy: "local",
    });
    try {
      assert.deepEqual(await rpc(third.endpoint, "environment.list", {}), {
        contract: "trust.environment-catalog@1",
        environments: [],
      });
      assert.deepEqual(await rpc(third.endpoint, "credential.list", {}), {
        contract: "trust.credential-catalog@1",
        credentials: [],
      });
    } finally {
      await third.close();
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

interface TrialView {
  readonly status: "starting" | "running" | "succeeded" | "failed" | "aborted";
}

async function waitForTrial(endpoint: string, trial: string): Promise<TrialView> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await rpc(endpoint, "operation.trial.read", { trial }) as { trial: TrialView };
    if (result.trial.status !== "starting" && result.trial.status !== "running") return result.trial;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Trial ${trial} did not finish`);
}

interface RpcEnvelope {
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly data?: { readonly contract?: string };
  };
}

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}

async function rpcEnvelope(endpoint: string, method: string, params: unknown): Promise<RpcEnvelope> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<RpcEnvelope>;
}
