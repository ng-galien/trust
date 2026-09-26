import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  admit,
  assertPrivateOutput,
  createAccessTestProvider,
  denied,
  engage,
  facts,
  privateCredential,
  resources,
  root,
  rpc,
  runnerModules,
  runPackaged,
  runtimeFixture,
  scopes,
  seed,
  storageTarget,
} from "./access-development-support.mjs";

test("DEV-DATABASE authenticated Runner preserves durable principal and rejects foreign submission", {
  timeout: 180000,
}, async (context) => {
  const provider = await createAccessTestProvider();
  const modules = await runnerModules();
  try {
    const alice = await provider.issue({ scope: scopes().join(" ") }),
      bob = await provider.issue({ subject: "bob", scope: scopes().join(" ") }),
      admin = await provider.issue({ subject: "admin", scope: resources.join(" ") });
    for (const kind of ["pglite", "postgresql"]) {
      const target = await storageTarget(kind);
      let runtime;
      try {
        runtime = await runtimeFixture(provider, target.storage);
        await seed(runtime.endpoint, admin.token);
        await rpc(runtime.endpoint, admin.token, "environment.save", {
          environment: "local",
          values: { workspaceRoot: path.dirname(root) },
        });
        const engaged = await rpc(
          runtime.endpoint,
          alice.token,
          "plan.engage",
          engage("runner-durable", "git-status", { mode: "live", rootInputs: { repository: path.basename(root) } }),
        );
        const file = await privateCredential(modules, runtime.endpoint, alice, `${kind}.json`);
        const completed = await runPackaged(runtime.endpoint, file, engaged.checkUris[0]);
        assert.equal(completed.code, 0, completed.stderr);
        assert.equal(completed.result.result.status, "COMPLETED");
        assertPrivateOutput(completed, [alice, bob]);
        const second = await rpc(
          runtime.endpoint,
          alice.token,
          "plan.engage",
          engage("foreign-attempt", "git-status", { mode: "live", rootInputs: { repository: path.basename(root) } }),
        );
        const admission = await rpc(runtime.endpoint, alice.token, "check.attempt.admit", admit(second.checkUris[0]));
        const db = runtime.container.resolve("database");
        const before = await db.selectFrom("attempt_fact_receipts").selectAll().execute();
        const bobFile = await privateCredential(modules, runtime.endpoint, bob, `${kind}-bob.json`);
        const auth = modules.module.createRunnerAuthorization(
          { TRUST_AUTH_FILE: bobFile },
          `${runtime.endpoint}/rpc`,
          `${runtime.endpoint}/v1/traces`,
        );
        const batch = facts(admission);
        await assert.rejects(
          new modules.module.OtlpFactExporter(`${runtime.endpoint}/v1/traces`, 3000, auth).export(batch),
        );
        await denied(runtime.endpoint, bob.token, "check.attempt.finalize", {
          contract: "trust.attempt-finalization-request@1",
          attemptHandle: admission.attemptHandle,
        });
        assert.deepEqual(
          await db.selectFrom("attempt_fact_receipts").selectAll().execute(),
          before,
          "Foreign OTLP creates no receipt",
        );
        const actor = await db
          .selectFrom("attempts")
          .select(["actor_issuer", "actor_subject"])
          .where("attempt_handle", "=", admission.attemptHandle)
          .executeTakeFirstOrThrow();
        assert.deepEqual(actor, { actor_issuer: provider.issuer, actor_subject: "alice" });
        await runtime.close();
        runtime = undefined;
        runtime = await runtimeFixture(provider, target.storage);
        const plan = await rpc(runtime.endpoint, alice.token, "plan.read", { plan: "runner-durable" });
        assert.equal(plan.creator.subject, "alice");
        await denied(runtime.endpoint, bob.token, "plan.read", { plan: "runner-durable" });
        assert.deepEqual(
          await runtime.container
            .resolve("database")
            .selectFrom("attempts")
            .select(["actor_issuer", "actor_subject"])
            .where("attempt_handle", "=", admission.attemptHandle)
            .executeTakeFirstOrThrow(),
          actor,
        );
        context.diagnostic(
          `${kind}: actual packaged Runner RPC+OTLP completed; foreign OTLP rejected with unchanged receipts; creator and actor survived reopen`,
        );
      } finally {
        await runtime?.close();
        await target.cleanup();
      }
    }
  } finally {
    await modules.cleanup();
    await provider.close();
  }
});
