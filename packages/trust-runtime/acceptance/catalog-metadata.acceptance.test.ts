import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CatalogMetadata } from "@trust/extension-sdk";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

async function rpc<T>(endpoint: string, method: string, params: unknown = {}): Promise<T> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  const envelope = (await response.json()) as { result?: T; error?: { message: string; code: number } };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  assert.notEqual(envelope.result, undefined);
  return envelope.result as T;
}

async function mcpText(endpoint: string, name: string, args: unknown): Promise<string> {
  const response = await fetch(`${endpoint}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const envelope = (await response.json()) as {
    result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    error?: unknown;
  };
  assert.equal(envelope.error, undefined);
  assert.notEqual(envelope.result?.isError, true);
  const content = envelope.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof content, "string");
  return content ?? "";
}

test("published catalog descriptions and tags can change without changing executable versions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-catalog-metadata-"));
  const operationsDirectory = path.join(directory, "operations");
  await cp(path.join(root, "assets/operations"), operationsDirectory, { recursive: true });
  const options = { databasePath: path.join(directory, "runtime.sqlite"), operationsDirectory };
  let runtime = await startPublicRuntime("trust-catalog-metadata-process-", options);
  try {
    const procedureSource = await readFile(
      path.join(root, "packages/trust-runtime/acceptance/fixtures/intent-chaining.feature"),
      "utf8",
    );
    await rpc(runtime.endpoint, "procedure.publish", {
      source: procedureSource,
      sourceName: "intent-chaining.feature",
    });
    const beforeOperations = await rpc<{ operations: Array<{ operation: string; version: string; source: string }> }>(
      runtime.endpoint,
      "operation.list",
    );
    const beforeProcedures = await rpc<{
      procedures: Array<{ procedure: { procedure: string; version: string; source: string } }>;
    }>(runtime.endpoint, "procedure.list");
    const initial = await rpc<CatalogMetadata[]>(runtime.endpoint, "catalog.metadata.list");
    const operation = initial.find((entry) => entry.kind === "operation" && entry.name === "git.head-read");
    const procedure = initial.find((entry) => entry.kind === "procedure" && entry.name === "intent-chaining");
    assert.ok(operation);
    assert.ok(procedure);
    assert.equal(operation.revision, 0);
    assert.equal(procedure.revision, 0);

    const updatedOperation = await rpc<CatalogMetadata>(runtime.endpoint, "catalog.metadata.save", {
      kind: "operation",
      name: operation.name,
      expectedRevision: 0,
      title: operation.title,
      description: "Read a repository's current head before choosing a follow-up.",
      tags: ["git", "read-only"],
    });
    const updatedProcedure = await rpc<CatalogMetadata>(runtime.endpoint, "catalog.metadata.save", {
      kind: "procedure",
      name: procedure.name,
      expectedRevision: 0,
      title: procedure.title,
      description: "Choose this procedure for a staged repository review.",
      tags: ["repository", "review"],
    });
    assert.equal(updatedOperation.revision, 1);
    assert.equal(updatedProcedure.revision, 1);
    assert.match(await mcpText(runtime.endpoint, "trust_operation_list", {}), /read-only/);
    assert.match(await mcpText(runtime.endpoint, "trust_procedure_list", {}), /staged repository review/);
    assert.match(
      await mcpText(runtime.endpoint, "trust_operation_read", { operation: operation.name, version: "1.0.0" }),
      /Tags: git, read-only/,
    );
    assert.match(
      await mcpText(runtime.endpoint, "trust_published_procedure_read", {
        procedure: procedure.name,
        version: "1.0.0",
      }),
      /Tags: repository, review/,
    );
    assert.deepEqual(await rpc(runtime.endpoint, "operation.list"), beforeOperations);
    assert.deepEqual(await rpc(runtime.endpoint, "procedure.list"), beforeProcedures);

    await runtime.close();
    runtime = await startPublicRuntime("trust-catalog-metadata-process-", options);
    const after = await rpc<CatalogMetadata[]>(runtime.endpoint, "catalog.metadata.list");
    assert.deepEqual(
      after.find((entry) => entry.kind === "operation" && entry.name === operation.name),
      updatedOperation,
    );
    assert.deepEqual(
      after.find((entry) => entry.kind === "procedure" && entry.name === procedure.name),
      updatedProcedure,
    );
    assert.deepEqual(
      await rpc(runtime.endpoint, "catalog.metadata.history", { kind: "procedure", name: procedure.name }),
      [updatedProcedure],
    );
    assert.deepEqual(await rpc(runtime.endpoint, "operation.list"), beforeOperations);
    assert.deepEqual(await rpc(runtime.endpoint, "procedure.list"), beforeProcedures);

    const withoutDescription = await rpc<CatalogMetadata>(runtime.endpoint, "catalog.metadata.save", {
      kind: "operation",
      name: operation.name,
      expectedRevision: 1,
      title: updatedOperation.title,
      tags: updatedOperation.tags,
    });
    assert.equal(withoutDescription.description, undefined);
    const operationRead = await mcpText(runtime.endpoint, "trust_operation_read", {
      operation: operation.name,
      version: "1.0.0",
    });
    assert.doesNotMatch(operationRead.split("\nSOURCE\n")[0] ?? "", /Description:/);
    assert.doesNotMatch(
      await mcpText(runtime.endpoint, "trust_operation_list", {}),
      /Read a repository's current head/,
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
