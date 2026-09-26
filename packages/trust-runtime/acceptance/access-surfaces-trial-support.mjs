import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAccessTestProvider } from "../../../environments/trust-test/auth/provider.mjs";
import { startRuntime } from "../dist/src/server.js";
import { denied, envelope, root, rpc } from "./access-ownership-support.mjs";

export async function sharedTrialJourney() {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-shared-trial-"));
  const provider = await createAccessTestProvider();
  let runtime;
  try {
    runtime = await startRuntime({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "data") },
      operationsDirectory: path.join(root, "assets/operations"),
      accessConfiguration: provider.configuration,
      accessResourceUrl: "http://127.0.0.1/mcp",
    });
    const endpoint = `http://127.0.0.1:${runtime.port}`;
    const administrator = await provider.issue({
      subject: "admin",
      scope: "trust.environment.save trust.operation.trial.read trust.operation.trial.list",
    });
    const credential = await provider.issue({ subject: "admin", scope: "trust.operation.trial.start" });
    await rpc(endpoint, administrator.token, "environment.save", {
      environment: "local",
      values: { workspaceRoot: path.dirname(root) },
    });
    const input = {
      operation: "git.head-read",
      version: "1.0.0",
      environment: "local",
      input: { project: path.basename(root) },
    };
    await denied(endpoint, undefined, "operation.trial.start", input);
    const forged = await envelope(endpoint, credential.token, "operation.trial.start", {
      ...input,
      authorization: "Bearer attacker-controlled",
    });
    assert.equal(forged.body.error?.code, -32602, "authorization is never an accepted Trial parameter");
    assert.deepEqual((await rpc(endpoint, administrator.token, "operation.trial.list", {})).trials, []);
    const started = await rpc(endpoint, credential.token, "operation.trial.start", input);
    let trial;
    for (const deadline = Date.now() + 15000; Date.now() < deadline; ) {
      trial = (await rpc(endpoint, administrator.token, "operation.trial.read", { trial: started.trial.id })).trial;
      if (trial.status !== "starting" && trial.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(trial.status, "succeeded");
    assert.equal(
      trial.outcome.diagnosticsFailures,
      0,
      "packaged Trial diagnostics must authenticate to the shared receiver",
    );
    for (const kind of ["operation.start", "step.start", "step.end", "operation.end", "trial.completed"])
      assert.ok(
        trial.events.some((event) => event.type === kind),
        `missing diagnostic ${kind}`,
      );
    assert.ok(
      !JSON.stringify(trial).includes(credential.token),
      "Trial state and diagnostics must not expose the bearer",
    );
    const stream = await fetch(`${endpoint}/otlp/diagnostics/trials/${trial.id}/stream`, {
      headers: { authorization: `Bearer ${administrator.token}` },
    });
    assert.equal(stream.status, 200);
    const text = await stream.text();
    assert.match(text, /event: operation\.start/);
    assert.match(text, /event: trial\.completed/);
    assert.ok(!text.includes(credential.token), "diagnostic SSE must not expose the bearer");
    assert.equal(
      (
        await fetch(`${endpoint}/otlp/diagnostics/v1/logs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
  } finally {
    await runtime?.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
}
