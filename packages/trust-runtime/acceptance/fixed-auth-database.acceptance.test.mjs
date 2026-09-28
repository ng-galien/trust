import assert from "node:assert/strict";
import test from "node:test";
import { controlledAuthority } from "./access-authority-support.mjs";
import { denied, engage, fixed, fixture, rpc, scopes, seed, storageTarget } from "./fixed-auth-support.mjs";

test("FIXED-OWNERSHIP persisted principals and permissions survive fixed access", { timeout: 180000 }, async () => {
  const provider = await controlledAuthority();
  try {
    for (const kind of ["pglite", "postgresql"]) {
      const target = await storageTarget(kind);
      const f = await fixture({ storage: target.storage });
      try {
        await f.start({ profile: "development", access: provider.configuration, resourceUrl: f.endpoint + "/mcp" });
        const credential = await provider.issue({
          subject: "alice",
          scope: [...scopes(), "trust.procedure.publish", "trust.environment.save"].join(" "),
        });
        await seed(f.endpoint, credential);
        await denied(f.endpoint, undefined, "plan.engage", engage("unauthenticated"));
        await rpc(f.endpoint, credential, "plan.engage", engage("alice-plan"));
        const before = await rpc(f.endpoint, credential, "plan.read", { plan: "alice-plan" });
        assert.deepEqual(before.creator, { issuer: provider.issuer, subject: "alice" });
        const authorityReads = { ...provider.counts };
        await f.start(fixed({ issuer: provider.issuer, subject: "bob", scopes: scopes() }));
        await denied(f.endpoint, undefined, "plan.read", { plan: "alice-plan" });
        assert.deepEqual((await rpc(f.endpoint, undefined, "plan.list", {})).plans, []);
        await f.start(fixed({ issuer: "https://other.example", scopes: scopes() }));
        await denied(f.endpoint, undefined, "plan.read", { plan: "alice-plan" });
        await f.start(fixed({ scopes: [] }));
        await denied(f.endpoint, undefined, "plan.list", {});
        await denied(f.endpoint, undefined, "plan.read", { plan: "alice-plan" });
        await f.start(fixed({ issuer: provider.issuer, subject: "operator", scopes: scopes("all") }));
        assert.deepEqual(
          (await rpc(f.endpoint, undefined, "plan.read", { plan: "alice-plan" })).creator,
          before.creator,
        );
        await f.start(fixed({ issuer: provider.issuer, scopes: scopes() }));
        const after = await rpc(f.endpoint, undefined, "plan.read", { plan: "alice-plan" });
        assert.deepEqual(after.creator, before.creator);
        assert.equal(after.revision, before.revision);
        assert.deepEqual(after.checks, before.checks);
        assert.deepEqual(provider.counts, authorityReads, "Fixed mode never contacts the previous issuer");
      } finally {
        await f.close();
        await target.cleanup();
      }
    }
  } finally {
    await provider.close();
  }
});
