import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TrialRecord } from "@trust/extension-sdk";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const execute = promisify(execFile);

test("public Trials dispatch both file formats and preserve JSON and directory failures", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-file-formats-"));
  const outside = await mkdtemp(path.join(tmpdir(), "trust-file-outside-"));
  await execute(process.execPath, [path.join(root, "packages/trust-runner/scripts/package-skill.ts")], { cwd: root });
  const runtime = await startPublicRuntime("trust-file-runtime-", {
    environments: { local: { workspaceRoot: directory } },
  });
  const rpc = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await fetch(`${runtime.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
    assert.equal(response.status, 200);
    const envelope = (await response.json()) as { result: T; error?: unknown };
    assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
    return envelope.result;
  };
  const trial = async (asset: string): Promise<TrialRecord> => {
    const source = await readFile(path.join(root, "assets/operations", asset), "utf8");
    const started = await rpc<{ trial: { id: string } }>("operation.trial.start", {
      source,
      environment: "local",
      input: {},
    });
    const deadline = Date.now() + 15_000;
    do {
      const { trial } = await rpc<{ trial: TrialRecord }>("operation.trial.read", { trial: started.trial.id });
      if (trial.status !== "starting" && trial.status !== "running") return trial;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error("Trial did not complete");
  };
  try {
    await writeFile(path.join(directory, "LICENSE"), "TRUST file dispatch\n");
    const text = await trial("file.license-read.feature");
    assert.equal(text.status, "succeeded", JSON.stringify(text));
    assert.deepEqual(text.events.find((event) => event.type === "operation.end")?.produced, {
      text: "TRUST file dispatch\n",
    });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "file-dispatch" }));
    const json = await trial("file.package-read.feature");
    assert.equal(json.status, "succeeded", JSON.stringify(json));
    assert.deepEqual(json.events.find((event) => event.type === "operation.end")?.produced, { name: "file-dispatch" });
    await writeFile(path.join(directory, "package.json"), "invalid-json");
    const invalid = await trial("file.package-read.feature");
    assert.equal(invalid.status, "failed");
    assert.match(JSON.stringify(invalid), /not valid JSON/);
    await rm(path.join(directory, "package.json"));
    await writeFile(path.join(outside, "package.json"), JSON.stringify({ name: "outside" }));
    await symlink(path.join(outside, "package.json"), path.join(directory, "package.json"));
    const escaped = await trial("file.package-read.feature");
    assert.equal(escaped.status, "failed");
    assert.match(JSON.stringify(escaped), /resolves outside Environment/);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
