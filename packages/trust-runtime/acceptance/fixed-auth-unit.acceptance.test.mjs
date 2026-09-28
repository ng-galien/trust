import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { entry, fixed, fixture, rpc } from "./fixed-auth-support.mjs";
import { command } from "./server-configuration-support.mjs";

test("FIXED-CONFIG public startup validates fixed identity and scopes", { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    await f.start();
    const auth = await (await fetch(`${f.endpoint}/auth/config`)).json();
    assert.equal(auth.required, false);
    assert.equal(auth.browser, null);
    assert.equal(auth.development, undefined);
    assert.deepEqual((await rpc(f.endpoint, undefined, "plan.list", {})).plans, []);
    await f.stop();
    const invalid = [
      fixed({ issuer: undefined }),
      fixed({ subject: "" }),
      fixed({ scopes: undefined }),
      fixed({ scopes: "trust.plan.read.own" }),
      fixed({ roles: ["admin"] }),
      fixed({ allowedOrigins: ["not-an-origin"] }),
      fixed({ scopes: ["admin"] }),
      fixed({ allowedOrigins: ["https://ui.example/path"] }),
      { ...fixed(), browser: {} },
      { profile: "shared", access: fixed().access },
    ];
    for (const authentication of invalid) {
      await writeFile(f.file, JSON.stringify({ ...f.configuration, authentication }));
      const result = await command([], { TRUST_CONFIG_FILE: f.file }, entry);
      assert.notEqual(result.code, 0, JSON.stringify(authentication));
      assert.doesNotMatch(result.stdout, /runtime listening/);
      assert.match(result.stderr, /configuration|authentication|access|issuer|subject|scopes|origin|unknown/i);
    }
  } finally {
    await f.close();
  }
});
