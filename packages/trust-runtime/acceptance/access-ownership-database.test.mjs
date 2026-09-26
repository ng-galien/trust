import assert from "node:assert/strict";
import test from "node:test";
import { createAccessTestProvider } from "../../../environments/trust-test/auth/provider.mjs";
import { buildPlanRevision } from "../dist/src/plan/build.js";
import {
  admit,
  denied,
  engage,
  facts,
  resources,
  rpc,
  runtimeFixture,
  scopes,
  seed,
  storageTarget,
} from "./access-ownership-support.mjs";

test("PLAN-DATABASE child inheritance and actor isolation persist across adapters", {
  timeout: 180000,
}, async (context) => {
  const provider = await createAccessTestProvider();
  try {
    const [alice, bob, admin] = await Promise.all([
      provider.issue({ subject: "alice", scope: scopes().join(" ") }),
      provider.issue({ subject: "bob", scope: scopes().join(" ") }),
      provider.issue({ subject: "admin", scope: [...scopes("all"), ...resources].join(" ") }),
    ]);
    for (const kind of ["pglite", "postgresql"]) {
      const target = await storageTarget(kind);
      let runtime;
      try {
        runtime = await runtimeFixture(provider, target.storage);
        const { endpoint, container } = runtime;
        await seed(endpoint, admin.token);
        await rpc(endpoint, alice.token, "plan.engage", engage("parent", "ownership-parent"));
        const parent = await rpc(endpoint, alice.token, "plan.read", { plan: "parent" });
        const child = parent.invocations[0].childPlan;
        assert.ok(child);
        const childView = await rpc(endpoint, alice.token, "plan.read", { plan: child });
        assert.deepEqual(parent.creator, { issuer: provider.issuer, subject: "alice" });
        assert.deepEqual(childView.creator, parent.creator);
        await denied(endpoint, bob.token, "plan.read", { plan: child });
        // An all-scope operator acts without replacing the original creator.
        const admission = await rpc(endpoint, admin.token, "check.attempt.admit", admit(childView.checks[0].checkUri));
        const db = container.resolve("database");
        const row = await db
          .selectFrom("attempts")
          .selectAll()
          .where("attempt_handle", "=", admission.attemptHandle)
          .executeTakeFirstOrThrow();
        assert.equal(row.actor_issuer, provider.issuer);
        assert.equal(row.actor_subject, "admin");
        await denied(endpoint, alice.token, "check.attempt.facts", facts(admission));
        await denied(endpoint, alice.token, "check.attempt.finalize", {
          contract: "trust.attempt-finalization-request@1",
          attemptHandle: admission.attemptHandle,
        });
        assert.equal(
          (
            await db
              .selectFrom("attempts")
              .selectAll()
              .where("attempt_handle", "=", admission.attemptHandle)
              .executeTakeFirstOrThrow()
          ).state,
          "pending",
        );
        assert.deepEqual(await db.selectFrom("attempt_fact_receipts").selectAll().execute(), []);
        await assert.rejects(
          db.updateTable("plans").set({ creator_subject: "bob" }).where("plan_slug", "=", "parent").execute(),
          (error) => error.code === "23514",
        );
        await assert.rejects(
          db
            .updateTable("attempts")
            .set({ actor_subject: "alice" })
            .where("attempt_handle", "=", admission.attemptHandle)
            .execute(),
          (error) => error.code === "23514",
        );
        await rpc(endpoint, bob.token, "plan.engage", engage("bob-child"));
        await assert.rejects(
          db
            .updateTable("child_generations")
            .set({ child_plan: "bob-child" })
            .where("parent_plan", "=", "parent")
            .execute(),
          (error) => error.code === "23514",
        );
        // Historical fixture represents an unattributed import, without guessing a creator.
        const published = await container.resolve("procedures").find("git-status", "2.0.0");
        const historical = buildPlanRevision({
          authority: "localhost:4318",
          procedure: published.procedure,
          plan: "historical",
          environment: "local",
          mode: "dry-run",
          metadata: { title: "Historical", labels: [], annotations: {} },
          rootInputs: { repository: "old" },
          revision: 1,
        });
        await container.resolve("planStore").saveRevision(historical, new Date().toISOString());
        await denied(endpoint, alice.token, "plan.read", { plan: "historical" });
        assert.equal((await rpc(endpoint, admin.token, "plan.read", { plan: "historical" })).creator, null);
        const ownPlans = (await rpc(endpoint, alice.token, "plan.list", {})).plans;
        assert.deepEqual(new Set(ownPlans.map((value) => value.plan)), new Set(["parent", child]));
        assert.ok(ownPlans.every((value) => value.creator.subject === "alice"));
        const allPlans = (await rpc(endpoint, admin.token, "plan.list", {})).plans;
        assert.equal(allPlans.length, 4);
        await rpc(endpoint, admin.token, "check.attempt.facts", facts(admission));
        await rpc(endpoint, admin.token, "check.attempt.finalize", {
          contract: "trust.attempt-finalization-request@1",
          attemptHandle: admission.attemptHandle,
        });
        assert.equal((await rpc(endpoint, alice.token, "plan.read", { plan: child })).creator.subject, "alice");
        const persistedCreator = await db
          .selectFrom("plans")
          .select(["creator_issuer", "creator_subject"])
          .where("plan_slug", "=", child)
          .executeTakeFirstOrThrow();
        const persistedActor = await db
          .selectFrom("attempts")
          .select(["actor_issuer", "actor_subject"])
          .where("attempt_handle", "=", admission.attemptHandle)
          .executeTakeFirstOrThrow();
        await runtime.close();
        runtime = undefined;
        runtime = await runtimeFixture(provider, target.storage);
        assert.equal((await rpc(runtime.endpoint, alice.token, "plan.read", { plan: child })).creator.subject, "alice");
        const reopened = runtime.container.resolve("database");
        assert.deepEqual(
          await reopened
            .selectFrom("plans")
            .select(["creator_issuer", "creator_subject"])
            .where("plan_slug", "=", child)
            .executeTakeFirstOrThrow(),
          persistedCreator,
        );
        assert.deepEqual(
          await reopened
            .selectFrom("attempts")
            .select(["actor_issuer", "actor_subject"])
            .where("attempt_handle", "=", admission.attemptHandle)
            .executeTakeFirstOrThrow(),
          persistedActor,
        );
        context.diagnostic(
          `${kind}: inherited creator, distinct actor, denial without mutation, immutable SQL constraints, legacy null scope, persisted reopen verified`,
        );
      } finally {
        await runtime?.close();
        await target.cleanup();
      }
    }
  } finally {
    await provider.close();
  }
});
