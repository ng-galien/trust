import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { engage, rpc, seed, storageTarget } from "./access-ownership-support.mjs";
import { command, freePort, setupConfiguration } from "./server-configuration-support.mjs";

test("CONFIG-STORAGE effective configuration preserves database ownership and runtime updates", {
  timeout: 120000,
}, async () => {
  for (const kind of ["pglite", "postgresql"]) {
    const target = await storageTarget(kind);
    const fixture = await setupConfiguration({
      storage: target.storage,
      server: { semanticAuthority: "storage.example:443" },
    });
    try {
      const server = await fixture.start();
      const endpoint = server.endpoint;
      await seed(endpoint, undefined);
      await rpc(endpoint, undefined, "plan.engage", engage("retained-fixture-plan"));
      await rpc(endpoint, undefined, "environment.save", {
        environment: "config-live",
        values: { directory: "/tmp/first" },
      });
      await rpc(endpoint, undefined, "environment.save", {
        environment: "config-live",
        values: { directory: "/tmp/changed" },
      });
      const environments = await rpc(endpoint, undefined, "environment.list", {});
      assert.match(JSON.stringify(environments), /\/tmp\/changed/);
      assert.doesNotMatch(JSON.stringify(environments), /\/tmp\/first/);
      await rpc(endpoint, undefined, "credential.save", {
        environment: "config-live",
        name: "marker",
        value: "private-runtime-marker",
      });
      const credentials = await rpc(endpoint, undefined, "credential.list", {});
      assert.doesNotMatch(JSON.stringify(credentials), /private-runtime-marker/);
      const second = await command(["server", "start"], {
        TRUST_CONFIG_FILE: fixture.file,
        TRUST_PORT: String(await freePort()),
        TRUST_WEB_PORT: String(await freePort()),
      });
      assert.notEqual(second.code, 0);
      assert.doesNotMatch(second.stdout, /running at/);
      const log = await readFile(path.join(fixture.configuration.server.stateDirectory, "runtime.log"), "utf8");
      assert.match(
        log,
        /already owned|already in use|ownership/i,
        "second runtime must fail on actual database ownership",
      );
      await writeFile(
        fixture.file,
        JSON.stringify({
          ...fixture.configuration,
          server: { ...fixture.configuration.server, semanticAuthority: "after-restart.example:443" },
        }),
      );
      assert.match(
        JSON.stringify(await rpc(endpoint, undefined, "plan.read", { plan: "retained-fixture-plan" })),
        /storage\.example:443/,
        "file edit does not reload a running process",
      );
      await fixture.stop();
      const restarted = await fixture.start();
      const plan = await rpc(restarted.endpoint, undefined, "plan.read", { plan: "retained-fixture-plan" });
      assert.equal(plan.plan, "retained-fixture-plan");
      assert.match(
        JSON.stringify(plan),
        /storage\.example:443/,
        "persisted Check URIs retain their original authority",
      );
      const newPlan = await rpc(restarted.endpoint, undefined, "plan.engage", engage("new-after-restart"));
      assert.match(JSON.stringify(newPlan), /after-restart\.example:443/);
      assert.match(JSON.stringify(await rpc(restarted.endpoint, undefined, "environment.list", {})), /\/tmp\/changed/);
      await rpc(restarted.endpoint, undefined, "credential.remove", { environment: "config-live", name: "marker" });
    } finally {
      await fixture.close();
      await target.cleanup();
    }
  }
});
