import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { createRuntimeContainer } from "../dist/src/runtime.js";

export const root = path.resolve(import.meta.dirname, "../../..");
export const actions = [
  "plan.engage",
  "plan.read",
  "plan.list",
  "plan.declarations.replace",
  "plan.close",
  "plan.reset",
  "plan.remove",
  "plan.resume",
  "check.read",
  "check.escalate",
  "check.attempt.admit",
  "check.attempt.facts",
  "check.attempt.finalize",
  "check.attempt.interrupt",
  "history.list",
  "session.read",
];
export const scopes = (scope = "own") => actions.map((action) => `trust.${action}.${scope}`);
export const resources = ["trust.procedure.publish", "trust.procedure.read", "trust.environment.save"];
export const parentSource = `@trust-dsl:1 @procedure:ownership-parent @version:1.0.0
Feature: Owned child Plans
  Background: Plan context
    Given Procedure scope
      | check | authorized | forbidden |
      | all | Observe repository state. | Change external state. |
    And one reference "repository"
  @scenario:child
  Scenario: Child
    Then Invocation "child" runs Procedure "git-status@2.0.0" on "repository" as Input "repository" and must establish "child complete"
`;

export async function storageTarget(kind) {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-access-ownership-"));
  if (kind === "pglite")
    return {
      storage: { kind, directory: path.join(directory, "data") },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  const adminUrl = process.env.TRUST_ACCEPTANCE_POSTGRES_URL ?? process.env.COORDINATION_VERIFICATION_DATABASE_URL;
  assert.ok(adminUrl, "Database evidence requires an explicit disposable PostgreSQL admin connection");
  const name = `trust_ownership_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  return {
    storage: { kind: "postgresql", connectionString: target.href },
    async cleanup() {
      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export async function runtimeFixture(issuer, storage) {
  const container = await createRuntimeContainer({
    storage,
    operationsDirectory: path.join(root, "assets/operations"),
    accessConfiguration: issuer.configuration,
  });
  const server = createServer(container.resolve("httpApp"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    container,
    endpoint,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await container.dispose();
    },
  };
}

export async function envelope(endpoint, token, method, params) {
  const response = await fetch(`${endpoint}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  return { status: response.status, body: await response.json() };
}
export async function rpc(endpoint, token, method, params) {
  const { status, body } = await envelope(endpoint, token, method, params);
  assert.ok(status < 400, `RPC ${method} HTTP ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, undefined, `${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
export async function denied(endpoint, token, method, params) {
  const result = await envelope(endpoint, token, method, params);
  assert.ok(
    result.status === 401 || result.status === 403 || result.body.error?.code === -32001,
    `${method} must deny`,
  );
  assert.match(
    JSON.stringify(result.body),
    /forbidden|unauthenticated|permission|principal|creator|authenticated|access denied/i,
  );
  return result;
}
export const engage = (plan, procedure = "git-status", extra = {}) => ({
  contract: "trust.plan-engagement-request@1",
  procedure,
  procedureVersion: procedure === "git-status" ? "2.0.0" : "1.0.0",
  plan,
  environment: "local",
  mode: "dry-run",
  rootInputs: { repository: "repository" },
  ...extra,
});
export const admit = (checkUri, attemptKey = randomUUID()) => ({
  contract: "trust.check-admission-request@1",
  checkUri,
  attemptKey,
});
export const facts = (admission) => ({
  contract: "trust.fact-batch-request@1",
  attemptKey: admission.attemptKey,
  attemptHandle: admission.attemptHandle,
  executionId: admission.executionId,
  checkUri: admission.checkUri,
  recordedAt: "2026-09-26T01:00:00.000Z",
  facts: [
    {
      kind: admission.operation.operation,
      observedAt: "2026-09-26T01:00:00.000Z",
      values: { headRevision: "revision-a", workingTree: "dirty" },
    },
  ],
});
export async function seed(endpoint, token) {
  await rpc(endpoint, token, "environment.save", { environment: "local", values: {} });
  await rpc(endpoint, token, "procedure.publish", {
    source: await readFile(path.join(root, "assets/procedures/00-git-status.feature"), "utf8"),
    sourceName: "git-status.feature",
  });
  await rpc(endpoint, token, "procedure.publish", { source: parentSource, sourceName: "ownership-parent.feature" });
}
