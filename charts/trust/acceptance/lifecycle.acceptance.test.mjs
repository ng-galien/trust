import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { storageTarget, seed, engage } from "../../../packages/trust-runtime/acceptance/access-ownership-support.mjs";
import { prepareRuntime, temporary, freePort, rpc, rm } from "./support.mjs";

test("HELM-LIFECYCLE single-owner rollout and persistence contracts hold", { timeout: 120000 }, async () => {
  for (const kind of ["pglite", "postgresql"]) {
    const directory = await temporary();
    let runtime, target;
    try {
      if (kind === "postgresql") target = await storageTarget("postgresql");
      runtime = await prepareRuntime(
        directory,
        kind === "postgresql"
          ? {
              storage: { kind },
              secretEnvironment: [{ name: "TRUST_DATABASE_URL", secretName: "disposable-db", key: "url" }],
              databaseUrl: target.storage.connectionString,
            }
          : {},
      );
      await runtime.start();
      await seed(runtime.endpoint, runtime.identity.token);
      await rpc(runtime, "plan.engage", engage("helm-retained-plan"));
      const owner = spawn(process.execPath, runtime.command, {
        env: { ...runtime.environment, TRUST_PORT: String(await freePort()), TRUST_WEB_PORT: String(await freePort()) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      owner.stdout.on("data", (value) => (output += value));
      owner.stderr.on("data", (value) => (output += value));
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          owner.kill("SIGKILL");
          reject(new Error("Competing database owner did not refuse startup"));
        }, 15000);
        owner.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.notEqual(code, 0);
      const log = await readFile(path.join(directory, "state/runtime.log"), "utf8");
      assert.ok(
        /ownership|already.*runtime|already.*owner/i.test(output + log),
        "Refusal is recorded by the actual database ownership boundary",
      );
      await runtime.stop();
      await runtime.start();
      const retained = await rpc(runtime, "plan.read", { plan: "helm-retained-plan" });
      assert.equal(retained.plan, "helm-retained-plan");
      assert.equal(runtime.documents.find((value) => value.kind === "Deployment").spec.strategy.type, "Recreate");
      assert.equal(runtime.documents.find((value) => value.kind === "Deployment").spec.replicas, 1);
    } finally {
      await runtime?.close();
      await target?.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
