import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { startPublicRuntime } from "./support/runtime-process.js";

const buildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("one runtime owns each database while independent databases and clean reopen remain available", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-storage-ownership-"));
  const storage = { kind: "pglite" as const, directory: path.join(directory, "data") };
  let first: Awaited<ReturnType<typeof startPublicRuntime>> | undefined;
  let independent: Awaited<ReturnType<typeof startPublicRuntime>> | undefined;
  let reopened: Awaited<ReturnType<typeof startPublicRuntime>> | undefined;
  try {
    first = await startPublicRuntime("trust-owner-first-", { storage });
    await rpc(first.endpoint, "environment.save", {
      environment: "persisted",
      values: { exact: "001", flag: "false" },
    });
    await assert.rejects(
      startPublicRuntime("trust-owner-refused-", { storage }),
      /already (has a runtime ownership marker|owned by another TRUST runtime)/,
    );
    assert.equal((await fetch(`${first.endpoint}/health`)).status, 200);
    independent = await startPublicRuntime("trust-owner-independent-", {
      storage: { kind: "pglite", directory: path.join(directory, "independent") },
    });
    await rpc(independent.endpoint, "environment.save", { environment: "independent", values: {} });
    await first.close();
    first = undefined;
    reopened = await startPublicRuntime("trust-owner-reopened-", { storage });
    const environments = await rpc(reopened.endpoint, "environment.list", {});
    assert.match(JSON.stringify(environments), /persisted/);
    assert.doesNotMatch(JSON.stringify(environments), /independent/);
    assert.match(JSON.stringify(environments), /"exact":"001"/);
  } finally {
    await Promise.all([first?.close(), independent?.close(), reopened?.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("typed storage preserves JSON arrays, booleans, revisions and runtime timestamp strings through public CRUD", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-storage-codecs-"));
  const storage = { kind: "pglite" as const, directory: path.join(directory, "data") };
  let runtime = await startPublicRuntime("trust-storage-codecs-process-", { storage });
  const draft = {
    id: "storage-codecs",
    title: "Storage codecs",
    description: "Exact template source and ordered JSON parameters",
    body: "# {{title}}\nUnicode: é — \n{{subject}}\n",
    parameters: [
      { name: "title", description: "Title", defaultValue: "Ordered" },
      { name: "subject", description: "Subject" },
    ],
    expectedRevision: 0,
  };
  try {
    const saved = (await rpc(runtime.endpoint, "template.save", draft)) as { revision: number; parameters: unknown };
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.parameters, draft.parameters);
    const source = (await rpc(runtime.endpoint, "registry.source.save", {
      name: "codec-registry",
      kind: "git",
      url: "https://example.com/trust.git",
      reference: "main",
    })) as { source: { createdAt: string; updatedAt: string } };
    assert.match(source.source.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(typeof source.source.updatedAt, "string");
    await runtime.close();
    runtime = await startPublicRuntime("trust-storage-codecs-reopened-", { storage });
    const read = (await rpc(runtime.endpoint, "template.read", { id: draft.id })) as {
      body: string;
      parameters: unknown;
    };
    assert.equal(read.body, draft.body);
    assert.deepEqual(read.parameters, draft.parameters);
    await rpc(runtime.endpoint, "template.remove", { id: draft.id, expectedRevision: 1 });
    assert.deepEqual(await rpc(runtime.endpoint, "template.list", {}), []);
    const recreated = (await rpc(runtime.endpoint, "template.save", draft)) as { revision: number };
    assert.equal(recreated.revision, 3);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("embedded ownership follows filesystem identity through symlink and case aliases", {
  skip: Boolean(process.env.TRUST_ACCEPTANCE_POSTGRES_URL),
  timeout: 30_000,
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-storage-alias-"));
  const actual = path.join(directory, "StorageCase");
  const linked = path.join(directory, "linked");
  const caseAlias = path.join(directory, "storagecase");
  const first = await startPublicRuntime("trust-alias-owner-", {
    storage: { kind: "pglite", directory: actual },
  });
  try {
    await symlink(actual, linked, "dir");
    await assert.rejects(
      startPublicRuntime("trust-symlink-refused-", {
        storage: { kind: "pglite", directory: linked },
      }),
      /already has a runtime ownership marker/,
    );
    const actualIdentity = await stat(actual, { bigint: true });
    const aliasIdentity = await stat(caseAlias, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (aliasIdentity) {
      assert.equal(aliasIdentity.dev, actualIdentity.dev);
      assert.equal(aliasIdentity.ino, actualIdentity.ino);
      await assert.rejects(
        startPublicRuntime("trust-case-refused-", {
          storage: { kind: "pglite", directory: caseAlias },
        }),
        /already has a runtime ownership marker/,
      );
      context.diagnostic("Case-insensitive volume: the second owner was refused through both case and symlink aliases");
    } else {
      context.diagnostic("Case-sensitive volume: symlink alias refusal verified; case alias is a different path");
    }
    const markers = (await readdir(directory)).filter((name) => name.startsWith(".trust-runtime-owner-"));
    assert.equal(markers.length, 1);
    await rpc(first.endpoint, "environment.save", { environment: "still-owned", values: {} });
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a crashed embedded owner leaves an explicit fail-closed marker without automatic takeover", {
  skip: Boolean(process.env.TRUST_ACCEPTANCE_POSTGRES_URL),
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-storage-crash-"));
  const storageDirectory = path.join(directory, "data");
  const environment = { ...process.env };
  delete environment.TRUST_DATABASE_PATH;
  delete environment.TRUST_DATABASE_URL;
  const child = spawn(process.execPath, [path.join(buildRoot, "src/index.js")], {
    env: {
      ...environment,
      TRUST_HOST: "127.0.0.1",
      TRUST_PORT: "0",
      TRUST_STORAGE: "pglite",
      TRUST_PGLITE_DIRECTORY: storageDirectory,
    },
    stdio: "pipe",
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Embedded runtime did not listen")), 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("TRUST runtime listening on")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Embedded runtime exited ${code}`));
      });
    });
    child.kill("SIGKILL");
    await once(child, "exit");
    const markers = (await readdir(directory)).filter((name) => name.startsWith(".trust-runtime-owner-"));
    assert.equal(markers.length, 1);
    const markerName = markers[0];
    assert.ok(markerName);
    const marker = path.join(directory, markerName);
    const original = await readFile(marker, "utf8");
    await assert.rejects(
      startPublicRuntime("trust-crash-refused-", {
        storage: { kind: "pglite", directory: storageDirectory },
      }),
      /After a crash, verify that no runtime owns this directory/,
    );
    assert.equal(await readFile(marker, "utf8"), original);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    // The fixture owns this crashed database; cleanup is not a runtime recovery mechanism.
    await rm(directory, { recursive: true, force: true });
  }
});

test("loss of the PostgreSQL ownership session fences the old runtime before a new owner resumes", {
  skip: !process.env.TRUST_ACCEPTANCE_POSTGRES_URL,
  timeout: 60_000,
}, async () => {
  const adminUrl = process.env.TRUST_ACCEPTANCE_POSTGRES_URL;
  assert.ok(adminUrl);
  const admin = new Client({ connectionString: adminUrl });
  const name = `trust_owner_loss_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let first: Awaited<ReturnType<typeof startPublicRuntime>> | undefined;
  let second: Awaited<ReturnType<typeof startPublicRuntime>> | undefined;
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  try {
    const storage = { kind: "postgresql" as const, connectionString: target.href };
    first = await startPublicRuntime("trust-owner-loss-first-", { storage });
    await rpc(first.endpoint, "environment.save", { environment: "before-loss", values: {} });
    const killed = await admin.query<{ stopped: boolean }>(
      "SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE datname=$1 AND application_name='trust-runtime-owner'",
      [name],
    );
    assert.deepEqual(killed.rows, [{ stopped: true }]);
    // Wait for the owner connection's error notification; no storage call may succeed afterward.
    let refused = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await rpc(first.endpoint, "template.list", {});
      } catch {
        refused = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(refused, true, "old runtime must stop using the database after owner loss");
    second = await startPublicRuntime("trust-owner-loss-second-", { storage });
    const environments = await rpc(second.endpoint, "environment.list", {});
    assert.match(JSON.stringify(environments), /before-loss/);
    await assert.rejects(rpc(first.endpoint, "environment.save", { environment: "after-loss", values: {} }));
    assert.doesNotMatch(JSON.stringify(await rpc(second.endpoint, "environment.list", {})), /after-loss/);
  } finally {
    await Promise.all([first?.close(), second?.close()]);
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
});

async function rpc(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  const envelope = (await response.json()) as { result?: unknown; error?: unknown };
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result;
}
