import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { createAccessTestProvider } from "../../../environments/trust-test/auth/provider.mjs";
import { authorityRuntime } from "./access-authority-support.mjs";

async function snapshot(database) {
  const tables = await database
    .selectFrom("information_schema.tables")
    .select("table_name")
    .where("table_schema", "=", "public")
    .where("table_type", "=", "BASE TABLE")
    .orderBy("table_name")
    .execute();
  const result = {};
  for (const { table_name } of tables) {
    const rows = await database.selectFrom(table_name).selectAll().execute();
    result[table_name] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return result;
}

test("AUTH-DATABASE denied access leaves actual persisted state unchanged", async (t) => {
  const provider = await createAccessTestProvider();
  t.after(() => provider.close());
  const admin = await provider.issue({
    subject: "admin",
    scope: "trust.environment.save trust.environment.list trust.credential.save",
  });
  const reader = await provider.issue({ subject: "alice", scope: "trust.environment.list" });
  const lanes = [{ name: "pglite", options: {} }];
  const postgresUrl = process.env.TRUST_ACCEPTANCE_POSTGRES_URL ?? process.env.COORDINATION_VERIFICATION_DATABASE_URL;
  assert.ok(
    postgresUrl,
    "Both adapter proofs require explicit TRUST_ACCEPTANCE_POSTGRES_URL pointing to an approved disposable-database host",
  );
  const adminClient = new Client({ connectionString: postgresUrl });
  await adminClient.connect();
  const databaseName = `trust_access_authority_${randomUUID().replaceAll("-", "")}`;
  await adminClient.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  await adminClient.end();
  t.after(async () => {
    const connection = new Client({ connectionString: postgresUrl });
    await connection.connect();
    try {
      await connection.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await connection.end();
    }
  });
  const target = new URL(postgresUrl);
  target.pathname = `/${databaseName}`;
  lanes.push({ name: "postgresql", options: { storage: { kind: "postgresql", connectionString: target.href } } });
  for (const lane of lanes)
    await t.test(lane.name, async () => {
      const runtime = await authorityRuntime(provider.configuration, lane.options);
      try {
        const created = await runtime.rpc(admin.token, "environment.save", {
          environment: "protected",
          values: { sentinel: "preserved" },
        });
        assert.equal(created.body.result?.contract, "trust.environment@1", JSON.stringify(created));
        const saved = await runtime.rpc(admin.token, "credential.save", {
          environment: "protected",
          name: "fixture",
          value: "disposable-value",
        });
        assert.equal(saved.body.result?.contract, "trust.credential@1", JSON.stringify(saved));
        const database = runtime.container.resolve("database");
        const before = await snapshot(database);
        assert.equal(before.environments.length, 1);
        assert.equal(before.environment_credentials.length, 1);
        for (const [method, params] of [
          ["environment.save", { environment: "protected", values: { sentinel: "overwritten" } }],
          ["environment.remove", { environment: "protected" }],
          ["credential.save", { environment: "protected", name: "fixture", value: "overwritten" }],
          ["credential.remove", { environment: "protected", name: "fixture" }],
        ]) {
          const denied = await runtime.rpc(reader.token, method, params);
          assert.equal(denied.body.error?.code, -32001, JSON.stringify(denied));
          assert.deepEqual(
            await snapshot(database),
            before,
            `${lane.name}: ${method} must leave every stored row unchanged`,
          );
        }
        const unauthenticated = await runtime.rpc(undefined, "environment.save", {
          environment: "unauthenticated",
          values: {},
        });
        assert.equal(unauthenticated.status, 401);
        assert.deepEqual(await snapshot(database), before);
        const listed = await runtime.rpc(reader.token, "environment.list");
        assert.equal(listed.body.result?.environments[0]?.values.sentinel, "preserved");
      } finally {
        await runtime.close();
      }
    });
});
