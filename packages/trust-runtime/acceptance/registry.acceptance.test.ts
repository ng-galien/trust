import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { startPublicRuntime } from "./support/runtime-process.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("an HTTP registry refuses an invalid artifact before import and reports imported and unchanged artifacts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-http-registry-"));
  const operationsDirectory = path.join(directory, "operations-catalog");
  await mkdir(operationsDirectory);
  const operation = await readFile(path.join(repositoryRoot, "assets/operations/git.head-read.feature"), "utf8");
  const procedure = await readFile(path.join(repositoryRoot, "assets/procedures/00-git-status.feature"), "utf8");
  let operationResponse = `${operation}\n# altered after the index was produced\n`;
  let expectedOperationName = "git.head-read";
  const registry = await serveRegistry(() => ({
    "/registry/index.json": JSON.stringify(registryIndex(operation, procedure, expectedOperationName)),
    "/registry/operations/git.head-read.feature": operationResponse,
    "/registry/procedures/00-git-status.feature": procedure,
  }));
  const runtime = await startPublicRuntime("trust-http-registry-runtime-", { operationsDirectory });
  try {
    const insecure = await rpcFailure(runtime.endpoint, "registry.source.save", {
      name: "insecure",
      kind: "http",
      url: "http://example.com/trust-registry.json",
    });
    assert.equal(insecure.code, -32_050);
    assert.equal(insecure.data?.reason, "invalid-source");

    const saved = await rpc(runtime.endpoint, "registry.source.save", {
      name: "tenant-http",
      kind: "http",
      url: `${registry.endpoint}/registry/not-used.json`,
    }) as { contract: string; source: { name: string; kind: string } };
    assert.equal(saved.contract, "trust.registry-source@1");
    assert.deepEqual(saved.source.name, "tenant-http");
    assert.deepEqual(saved.source.kind, "http");
    const updated = await rpc(runtime.endpoint, "registry.source.save", {
      name: "tenant-http",
      kind: "http",
      url: `${registry.endpoint}/registry/index.json`,
    }) as { source: { url: string } };
    assert.equal(updated.source.url, `${registry.endpoint}/registry/index.json`);

    const rejected = await rpcFailure(runtime.endpoint, "registry.source.sync", { name: "tenant-http" });
    assert.equal(rejected.code, -32_050);
    assert.equal(rejected.data?.reason, "artifact-integrity-mismatch");
    assert.deepEqual(rejected.data?.summary, { imported: 0, unchanged: 0, failed: 1 });
    assert.deepEqual(
      (await rpc(runtime.endpoint, "operation.list", {}) as { operations: unknown[] }).operations,
      [],
    );
    assert.deepEqual(
      (await rpc(runtime.endpoint, "procedure.list", {}) as { procedures: unknown[] }).procedures,
      [],
    );

    operationResponse = operation;
    expectedOperationName = "git.wrong-name";
    const wrongIdentity = await rpcFailure(runtime.endpoint, "registry.source.sync", { name: "tenant-http" });
    assert.equal(wrongIdentity.data?.reason, "artifact-identity-mismatch");
    assert.deepEqual(
      (await rpc(runtime.endpoint, "operation.list", {}) as { operations: unknown[] }).operations,
      [],
    );

    expectedOperationName = "git.head-read";
    const first = await rpc(runtime.endpoint, "registry.source.sync", { name: "tenant-http" }) as RegistrySync;
    assert.equal(first.contract, "trust.registry-sync@1");
    assert.deepEqual(first.summary, { imported: 2, unchanged: 0, failed: 0 });
    assert.deepEqual(first.artifacts.map(({ kind, name, status }) => ({ kind, name, status })), [
      { kind: "operation", name: "git.head-read", status: "imported" },
      { kind: "procedure", name: "git-status", status: "imported" },
    ]);

    const replay = await rpc(runtime.endpoint, "registry.source.sync", { name: "tenant-http" }) as RegistrySync;
    assert.deepEqual(replay.summary, { imported: 0, unchanged: 2, failed: 0 });
    assert.ok(replay.artifacts.every(({ status }) => status === "unchanged"));
    assert.equal(
      (await rpc(runtime.endpoint, "operation.read", {
        operation: "git.head-read",
        version: "1.0.0",
      }) as { operation: string }).operation,
      "git.head-read",
    );
    assert.equal(
      (await rpc(runtime.endpoint, "procedure.read", {
        procedure: "git-status",
        version: "2.0.0",
      }) as { procedure: { procedure: string } }).procedure.procedure,
      "git-status",
    );
  } finally {
    await runtime.close();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a named Git registry source clones one repository and survives a runtime restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-git-registry-"));
  const repository = path.join(directory, "tenant-repository");
  const operationsDirectory = path.join(directory, "operations-catalog");
  const databasePath = path.join(directory, "trust.sqlite");
  await Promise.all([
    mkdir(path.join(repository, "operations"), { recursive: true }),
    mkdir(path.join(repository, "procedures"), { recursive: true }),
    mkdir(operationsDirectory, { recursive: true }),
  ]);
  const operation = await readFile(path.join(repositoryRoot, "assets/operations/git.head-read.feature"), "utf8");
  const procedure = await readFile(path.join(repositoryRoot, "assets/procedures/00-git-status.feature"), "utf8");
  await Promise.all([
    writeFile(path.join(repository, "operations/git.head-read.feature"), operation),
    writeFile(path.join(repository, "procedures/00-git-status.feature"), procedure),
    writeFile(path.join(repository, "trust-registry.json"), JSON.stringify(registryIndex(operation, procedure))),
  ]);
  await execFileAsync("git", ["init", "--quiet", repository]);
  await execFileAsync("git", ["-C", repository, "add", "."]);
  await execFileAsync("git", [
    "-C", repository,
    "-c", "user.name=TRUST Acceptance",
    "-c", "user.email=trust-acceptance@example.invalid",
    "commit", "--quiet", "-m", "registry fixture",
  ]);

  const firstRuntime = await startPublicRuntime("trust-git-registry-first-", {
    databasePath,
    operationsDirectory,
  });
  try {
    const credentials = await rpcFailure(firstRuntime.endpoint, "registry.source.save", {
      name: "git-with-credentials",
      kind: "git",
      url: "https://operator:secret@example.invalid/registry.git",
    });
    assert.equal(credentials.data?.reason, "invalid-source");
    await rpc(firstRuntime.endpoint, "registry.source.save", {
      name: "tenant-git",
      kind: "git",
      url: repository,
    });
    const synchronized = await rpc(firstRuntime.endpoint, "registry.source.sync", { name: "tenant-git" }) as RegistrySync;
    assert.deepEqual(synchronized.summary, { imported: 2, unchanged: 0, failed: 0 });
  } finally {
    await firstRuntime.close();
  }

  const secondRuntime = await startPublicRuntime("trust-git-registry-second-", {
    databasePath,
    operationsDirectory,
  });
  try {
    const listed = await rpc(secondRuntime.endpoint, "registry.source.list", {}) as {
      contract: string;
      sources: readonly { name: string; kind: string; url: string }[];
    };
    assert.equal(listed.contract, "trust.registry-source-catalog@1");
    assert.deepEqual(listed.sources.map(({ name, kind, url }) => ({ name, kind, url })), [
      { name: "tenant-git", kind: "git", url: repository },
    ]);
    assert.equal(
      (await rpc(secondRuntime.endpoint, "procedure.read", {
        procedure: "git-status",
        version: "2.0.0",
      }) as { procedure: { procedure: string } }).procedure.procedure,
      "git-status",
    );
    assert.deepEqual(await rpc(secondRuntime.endpoint, "registry.source.remove", { name: "tenant-git" }), {
      contract: "trust.registry-source-removal@1",
      name: "tenant-git",
      removed: true,
    });
    assert.deepEqual(
      (await rpc(secondRuntime.endpoint, "registry.source.list", {}) as { sources: unknown[] }).sources,
      [],
    );
  } finally {
    await secondRuntime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Git registry cannot read its index through a symlink outside the checkout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-git-registry-symlink-"));
  const repository = path.join(directory, "registry");
  const outsideIndex = path.join(directory, "outside-index.json");
  const operationsDirectory = path.join(directory, "operations-catalog");
  await Promise.all([mkdir(repository), mkdir(operationsDirectory)]);
  await writeFile(outsideIndex, JSON.stringify({ contract: "trust.registry-index@1", artifacts: [] }));
  await symlink(outsideIndex, path.join(repository, "trust-registry.json"));
  await execFileAsync("git", ["init", "--quiet", repository]);
  await execFileAsync("git", ["-C", repository, "add", "."]);
  await execFileAsync("git", [
    "-C", repository,
    "-c", "user.name=TRUST Acceptance",
    "-c", "user.email=trust-acceptance@example.invalid",
    "commit", "--quiet", "-m", "symlink registry fixture",
  ]);
  const runtime = await startPublicRuntime("trust-git-registry-symlink-runtime-", { operationsDirectory });
  try {
    await rpc(runtime.endpoint, "registry.source.save", {
      name: "symlink-git",
      kind: "git",
      url: repository,
    });
    const rejected = await rpcFailure(runtime.endpoint, "registry.source.sync", { name: "symlink-git" });
    assert.equal(rejected.data?.reason, "invalid-index");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

interface RegistrySync {
  readonly contract: string;
  readonly artifacts: readonly {
    readonly kind: string;
    readonly name: string;
    readonly version: string;
    readonly status: "imported" | "unchanged";
  }[];
  readonly summary: { readonly imported: number; readonly unchanged: number; readonly failed: number };
}

function registryIndex(operation: string, procedure: string, operationName = "git.head-read"): unknown {
  return {
    contract: "trust.registry-index@1",
    artifacts: [
      {
        kind: "operation",
        path: "operations/git.head-read.feature",
        name: operationName,
        version: "1.0.0",
        sha256: sha256(operation),
      },
      {
        kind: "procedure",
        path: "procedures/00-git-status.feature",
        name: "git-status",
        version: "2.0.0",
        sha256: sha256(procedure),
      },
    ],
  };
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function serveRegistry(content: () => Readonly<Record<string, string>>): Promise<{
  readonly endpoint: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const body = content()[request.url ?? ""];
    if (body === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", request.url?.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8");
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}

async function rpcFailure(endpoint: string, method: string, params: unknown): Promise<{
  readonly code?: number;
  readonly data?: { readonly reason?: string; readonly summary?: unknown };
}> {
  const envelope = await rpcEnvelope(endpoint, method, params);
  assert.ok(envelope.error);
  return envelope.error;
}

async function rpcEnvelope(endpoint: string, method: string, params: unknown): Promise<{
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly data?: { readonly reason?: string; readonly summary?: unknown } };
}> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    readonly result?: unknown;
    readonly error?: { readonly code?: number; readonly data?: { readonly reason?: string; readonly summary?: unknown } };
  }>;
}
