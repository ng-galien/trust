import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";
import {
  createAccessTestProvider,
  DEVELOPMENT_RESOURCE,
  DEVELOPMENT_SCOPES,
} from "../../../environments/trust-test/auth/provider.mjs";
import { startRuntime } from "../dist/src/server.js";
import { engage, root, rpc, seed } from "./access-ownership-support.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}

test("SURFACE-BROWSER real PKCE browser access persists only authorized business data", {
  timeout: 120000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-access-browser-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const provider = await createAccessTestProvider({
    browserRedirectUri: origin + "/auth/callback",
    browserPostLogoutUri: origin + "/",
  });
  let runtime, vite, browser;
  try {
    const browserConfiguration = {
      issuer: provider.issuer,
      clientId: "trust-browser",
      redirectUri: origin + "/auth/callback",
      postLogoutRedirectUri: origin + "/",
      scope:
        "openid offline_access " +
        DEVELOPMENT_SCOPES.filter((scope) => scope.endsWith(".own") || /\.(read|list)$/.test(scope)).join(" "),
      resource: DEVELOPMENT_RESOURCE,
    };
    runtime = await startRuntime({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "data") },
      operationsDirectory: path.join(root, "assets/operations"),
      accessConfiguration: provider.configuration,
      browserAuthentication: browserConfiguration,
      accessResourceUrl: origin + "/mcp",
    });
    const endpoint = `http://127.0.0.1:${runtime.port}`;
    const admin = await provider.issue({ subject: "admin", scope: DEVELOPMENT_SCOPES.join(" ") });
    await seed(endpoint, admin.token);
    const alice = await provider.issue({ subject: "bob" });
    await rpc(endpoint, alice.token, "plan.engage", engage("browser-bob"));
    vite = spawn(
      process.execPath,
      [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: path.join(root, "apps/trust-web"),
        env: { ...process.env, TRUST_RUNTIME_URL: endpoint, TRUST_WEB_PORT: String(port) },
        stdio: "ignore",
      },
    );
    let started = false;
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(origin + "/health")).ok) {
          started = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(started, "isolated web must start");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const leaks = [];
    let authorizationUrl;
    let callbackUrl;
    page.on("request", (request) => {
      const u = new URL(request.url());
      if (u.searchParams.has("access_token") || u.searchParams.has("refresh_token")) leaks.push(u.pathname);
      if (u.searchParams.has("code_challenge")) authorizationUrl = u;
      if (u.pathname === "/auth/callback" && u.searchParams.has("code")) callbackUrl = u.href;
    });
    async function signIn(target, subject) {
      target.setDefaultTimeout(15000);
      await target.goto(origin);
      await target.getByRole("button", { name: "Sign in", exact: true }).click();
      await target.locator('input[name="login"]').fill(subject);
      await target.locator('input[name="password"]').fill("development-only-ignored");
      await target.locator("form").getByRole("button").click();
      await target.locator('form:has(input[value="consent"]) button').click();
    }
    async function browserRpc(method, params) {
      return page.evaluate(
        async ({ root, method, params }) => {
          const module = await import("/@fs" + root + "/packages/trust-ui/src/lib/authentication.ts");
          const response = await module.authenticatedFetch("/rpc", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          return response.json();
        },
        { root, method, params },
      );
    }
    await signIn(page, "alice");
    await page.waitForURL(origin + "/overview");
    await page.getByRole("button", { name: "Sign out of TRUST", exact: true }).waitFor();
    assert.ok(authorizationUrl.searchParams.get("nonce"));
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    const result = await browserRpc("plan.engage", engage("browser-created"));
    assert.equal(result.result?.plan, "browser-created");
    const refused = await browserRpc("plan.remove", { plan: "browser-bob" });
    assert.equal(refused.error?.code, -32001);
    const listed = await browserRpc("plan.list", {});
    assert.ok(listed.result?.plans.some((plan) => plan.plan === "browser-created"));
    assert.ok(!listed.result.plans.some((plan) => plan.plan === "browser-bob"));
    const stored = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    assert.doesNotMatch(
      JSON.stringify(stored),
      /access_token|refresh_token|id_token|eyJ[a-zA-Z0-9_-]+\./,
      "issued tokens never persist in browser storage",
    );
    assert.deepEqual(leaks, []);
    // Force a genuine refresh attempt to fail and observe the application's state transition.
    await page.route(provider.issuer + "/token", (route) =>
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_grant" }) }),
    );
    await page.clock.install();
    await page.clock.setFixedTime(Date.now() + 100000);
    const refresh = await page.evaluate(async (root) => {
      const module = await import("/@fs" + root + "/packages/trust-ui/src/lib/authentication.ts");
      try {
        await module.authenticationFor("").token();
        return "unexpected";
      } catch {
        return "sign-in-required";
      }
    }, root);
    assert.equal(refresh, "sign-in-required");
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    // A consumed callback cannot re-establish an authenticated session.
    await page.goto(callbackUrl);
    await page.getByText("Sign-in is unavailable.", { exact: false }).waitFor();
    const other = await browser.newPage();
    await other.route(provider.issuer + "/auth?*", (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("nonce", "different-from-recorded-transaction");
      return route.continue({ url: url.href });
    });
    await signIn(other, "alice");
    await other.getByText("Sign-in is unavailable.", { exact: false }).waitFor();
    await other.close();
    const race = await browser.newPage();
    await signIn(race, "alice");
    await race.getByRole("button", { name: "Sign out of TRUST", exact: true }).waitFor();
    let hold;
    const held = new Promise((resolve) => {
      hold = resolve;
    });
    await race.route(provider.issuer + "/token", (route) => {
      hold(route);
    });
    await race.clock.install();
    await race.clock.setFixedTime(Date.now() + 100000);
    await race.evaluate(async (root) => {
      const module = await import("/@fs" + root + "/packages/trust-ui/src/lib/authentication.ts");
      window.renewalResult = undefined;
      void module
        .authenticationFor("")
        .token()
        .then(() => {
          window.renewalResult = "unexpected";
        })
        .catch(() => {
          window.renewalResult = "signed-out";
        });
    }, root);
    const pendingRoute = await held;
    await race.getByRole("button", { name: "Sign out of TRUST", exact: true }).click();
    await pendingRoute.continue();
    await race.waitForFunction(() => window.renewalResult !== undefined);
    assert.equal(await race.evaluate(() => window.renewalResult), "signed-out");
    await race.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await race.close();
    // Reopening the durable store proves allowed data persisted and the denied delete did not.
    await runtime.close();
    runtime = await startRuntime({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "data") },
      operationsDirectory: path.join(root, "assets/operations"),
      accessConfiguration: provider.configuration,
    });
    const persisted = await rpc(`http://127.0.0.1:${runtime.port}`, admin.token, "plan.list", {});
    assert.ok(persisted.plans.some((plan) => plan.plan === "browser-created"));
    assert.ok(persisted.plans.some((plan) => plan.plan === "browser-bob"));
  } finally {
    await browser?.close();
    if (vite) {
      vite.kill("SIGTERM");
      await new Promise((r) => {
        if (vite.exitCode !== null) r();
        else vite.once("exit", r);
      });
    }
    await runtime?.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
