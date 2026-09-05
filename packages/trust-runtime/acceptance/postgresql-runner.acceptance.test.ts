import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startPublicRuntime } from "./support/runtime-process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const execute = promisify(execFile);
const databaseUrl = process.env.TRUST_POSTGRESQL_ACCEPTANCE_URL;

test("the public Trial dispatches PostgreSQL through its packaged runner and reports the persisted result", {
  skip: !databaseUrl,
  timeout: 60_000,
}, async () => {
  // This fixture owns only a unique schema; the retained database and its other data remain intact.
  const schema = `trust_runner_${randomUUID().replaceAll("-", "")}`;
  const sql = (statement: string) =>
    execute("psql", [databaseUrl!, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement]);
  const directory = await mkdtemp(path.join(tmpdir(), "trust-postgresql-runner-"));
  await sql(`CREATE SCHEMA ${schema}`);
  let runtime: Awaited<ReturnType<typeof startPublicRuntime>> | undefined;
  try {
    await sql(`CREATE TABLE ${schema}.trust_connector_claims (resource text PRIMARY KEY, owner text NOT NULL)`);
    const source = (
      await readFile(
        path.join(root, "packages/trust-runner/acceptance/fixtures/postgresql.atomic-claim.feature"),
        "utf8",
      )
    ).replaceAll("trust_connector_claims", `${schema}.trust_connector_claims`);
    await writeFile(path.join(directory, "claim.feature"), source);
    await execute(process.execPath, [path.join(root, "packages/trust-runner/scripts/package-skill.ts")], { cwd: root });
    runtime = await startPublicRuntime("trust-postgresql-trial-", {
      operationsDirectory: directory,
      environments: { acceptance: { databaseUrl: databaseUrl! } },
    });
    const rpc = async (method: string, params: unknown): Promise<unknown> => {
      const response = await fetch(`${runtime!.endpoint}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
      });
      assert.equal(response.status, 200);
      const envelope = (await response.json()) as { result?: unknown; error?: unknown };
      assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
      return envelope.result;
    };
    for (const [owner, expectedState] of [
      ["first-agent", "claimed"],
      ["second-agent", "busy"],
    ]) {
      const started = (await rpc("operation.trial.start", {
        operation: "postgresql.atomic-claim",
        version: "1.0.0",
        environment: "acceptance",
        input: { resource: "one-key", owner },
      })) as { trial: { id: string } };
      let trial: Trial | undefined;
      const deadline = Date.now() + 20_000;
      do {
        trial = ((await rpc("operation.trial.read", { trial: started.trial.id })) as { trial: Trial }).trial;
        if (!["starting", "running"].includes(trial.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      assert.equal(trial.status, "succeeded", JSON.stringify(trial));
      const start = trial.events.find((event) => event.type === "step.start");
      assert.equal(start?.kind, "postgresql");
      assert.match(String(start?.summary), /PostgreSQL Environment/);
      const end = trial.events.find((event) => event.type === "operation.end");
      assert.deepEqual(end?.produced, { resource: "one-key", owner: "first-agent", state: expectedState });
      assert.ok(trial.events.some((event) => event.type === "step.end" && event.ok === true));
    }
    assert.equal(
      (await sql(`SELECT resource || ':' || owner FROM ${schema}.trust_connector_claims`)).stdout.trim(),
      "one-key:first-agent",
    );
  } finally {
    await runtime?.close();
    await sql(`DROP SCHEMA ${schema} CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});

interface Trial {
  readonly status: string;
  readonly events: ReadonlyArray<Record<string, unknown>>;
}
