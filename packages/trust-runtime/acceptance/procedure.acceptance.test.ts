import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startPublicRuntime } from "./support/runtime-process.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("the runtime compiles, publishes and reads one Procedure with its exact Operation", async () => {
  const runtime = await startPublicRuntime("trust-procedure-", {
    skillPolicy: "local",
    operationsDirectory: path.join(repositoryRoot, "assets/operations"),
    environments: { local: { workspaceRoot: repositoryRoot } },
  });
  try {
    const source = await readFile(
      path.join(repositoryRoot, "assets/procedures/00-git-status.feature"),
      "utf8",
    );
    const compiled = await rpc(runtime.endpoint, "procedure.compile", {
      source,
      sourceName: "00-git-status.feature",
    }) as {
      contract: string;
      procedure: string;
      version: string;
      operations: readonly { operation: string; definition: { operation: string } }[];
    };
    assert.equal(compiled.contract, "trust.compiled-procedure@3");
    assert.equal(compiled.procedure, "git-status");
    assert.equal(compiled.version, "2.0.0");
    assert.deepEqual(compiled.operations.map((item) => item.operation), ["git.head-read"]);
    assert.equal(compiled.operations[0]?.definition.operation, "git.head-read");

    const published = await rpc(runtime.endpoint, "procedure.publish", {
      source,
      sourceName: "00-git-status.feature",
    }) as { contract: string; procedure: typeof compiled };
    assert.equal(published.contract, "trust.published-procedure@1");
    assert.deepEqual(published.procedure, compiled);

    const read = await rpc(runtime.endpoint, "procedure.read", {
      procedure: "git-status",
      version: "2.0.0",
    });
    assert.deepEqual(read, published);
  } finally {
    await runtime.close();
  }
});

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  const envelope = await response.json() as { result?: unknown; error?: unknown };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}
