import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";
import {
  engage,
  fixed,
  fixture,
  issuer,
  mcp,
  probeExtension,
  resources,
  root,
  rpc,
  scopes,
  seed,
} from "./fixed-auth-support.mjs";
import { cleanEnvironment, command } from "./server-configuration-support.mjs";

test("FIXED-TRANSPORT UI MCP Runner and extensions use configured fixed access", { timeout: 120000 }, async () => {
  const f = await fixture();
  let vite, browser;
  try {
    f.configuration.server.extensionsFile = await probeExtension(f.directory);
    const permissions = [...scopes(), ...resources, "trust.procedure.list", "trust.extension.dragon-heist.use"];
    await f.start(fixed({ scopes: permissions, allowedOrigins: [`http://127.0.0.1:${f.webPort}`] }));
    await seed(f.endpoint);
    await rpc(f.endpoint, undefined, "environment.save", {
      environment: "local",
      values: { workspaceRoot: path.dirname(root) },
    });
    const engaged = await rpc(
      f.endpoint,
      undefined,
      "plan.engage",
      engage("fixed-runner", "git-status", { mode: "live", rootInputs: { repository: path.basename(root) } }),
    );
    const runner = await command(
      [engaged.checkUris[0], "--json"],
      cleanEnvironment({ TRUST_RPC_ENDPOINT: `${f.endpoint}/rpc`, TRUST_OTLP_ENDPOINT: `${f.endpoint}/v1/traces` }),
      path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"),
    );
    assert.equal(runner.code, 0, runner.stderr + runner.stdout);
    const result = JSON.parse(runner.stdout);
    assert.equal(result.result.status, "COMPLETED");
    assert.equal(result.result.qualification.verdict, "VALIDATED");
    const check = await rpc(f.endpoint, undefined, "check.read", {
      contract: "trust.check-read-request@1",
      checkUri: engaged.checkUris[0],
    });
    assert.deepEqual(check.attempts[0].actor, { issuer, subject: "alice" });
    const webOrigin = `http://127.0.0.1:${f.webPort}`;
    vite = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        String(f.webPort),
        "--strictPort",
      ],
      {
        cwd: path.join(root, "apps/trust-web"),
        env: cleanEnvironment({ TRUST_RUNTIME_URL: f.endpoint, TRUST_WEB_PORT: String(f.webPort) }),
        stdio: "ignore",
      },
    );
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(webOrigin + "/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Isolated UI must start");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requests = [];
    page.on("request", (request) =>
      requests.push({ url: request.url(), authorization: request.headers().authorization }),
    );
    await page.goto(webOrigin + "/plans");
    await page.getByText("fixed-runner", { exact: true }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Sign in", exact: true }).count(), 0);
    await page.reload();
    await page.getByText("fixed-runner", { exact: true }).first().waitFor();
    assert.ok(requests.some((request) => request.url.endsWith("/rpc")));
    assert.ok(requests.every((request) => !request.authorization && !request.url.includes("/auth/dev/token")));
    await browser.close();
    browser = undefined;
    const withIgnoredBearer = await rpc(f.endpoint, "untrusted-client-value", "plan.read", { plan: "fixed-runner" });
    assert.deepEqual(withIgnoredBearer.creator, { issuer, subject: "alice" });
    const pending = await rpc(
      f.endpoint,
      undefined,
      "plan.engage",
      engage("fixed-denied-runner", "git-status", { mode: "live", rootInputs: { repository: path.basename(root) } }),
    );
    const viaMcp = await mcp(f.endpoint, "trust_plan_read", { plan: "fixed-runner" });
    assert.notEqual(viaMcp.result?.isError, true, JSON.stringify(viaMcp));
    assert.match(JSON.stringify(viaMcp), /fixed-runner/);
    const invoke = () =>
      fetch(`${f.endpoint}/extensions/dragon-heist/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "identity.read",
          arguments: { principal: { issuer: "forged", subject: "forged" } },
        }),
      });
    const extension = await invoke();
    assert.equal(extension.status, 200, await extension.clone().text());
    assert.deepEqual((await extension.json()).principal, { issuer, subject: "alice" });
    const extensionMcp = await mcp(f.endpoint, "trust_extension_dragon_heist", {
      command: "identity.read",
      arguments: {},
    });
    assert.notEqual(extensionMcp.result?.isError, true, JSON.stringify(extensionMcp));
    assert.match(JSON.stringify(extensionMcp), /alice/);
    const refused = await fetch(`${f.endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plan.list", params: {} }),
    });
    assert.equal(refused.status, 403);
    await f.start(fixed({ scopes: ["trust.plan.read.own"] }));
    const deniedRunner = await command(
      [pending.checkUris[0], "--json"],
      cleanEnvironment({ TRUST_RPC_ENDPOINT: `${f.endpoint}/rpc`, TRUST_OTLP_ENDPOINT: `${f.endpoint}/v1/traces` }),
      path.join(root, "packages/trust-runner/dist/skill/trust/scripts/run.js"),
    );
    assert.ok(
      deniedRunner.code !== 0 || JSON.parse(deniedRunner.stdout).result.status === "REFUSED",
      "Missing admission permission must refuse Runner execution",
    );
    assert.match(deniedRunner.stdout + deniedRunner.stderr, /forbidden|denied|permission/i);
    const unchanged = await rpc(f.endpoint, undefined, "plan.read", { plan: "fixed-denied-runner" });
    assert.equal(unchanged.revision, 1);

    assert.equal((await invoke()).status, 403, "Fixed identity does not grant extension use");
    const deniedMcp = await mcp(f.endpoint, "trust_extension_dragon_heist", {
      command: "identity.read",
      arguments: {},
    });
    assert.equal(deniedMcp.result.isError, true);
  } finally {
    await browser?.close();
    if (vite && vite.exitCode === null && vite.signalCode === null) {
      const done = once(vite, "exit");
      vite.kill("SIGTERM");
      await done;
    }
    await f.close();
  }
});
