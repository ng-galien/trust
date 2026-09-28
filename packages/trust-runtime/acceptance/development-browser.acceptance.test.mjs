import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "@playwright/test";
import { startRuntime } from "../dist/src/server.js";

const root = path.resolve(import.meta.dirname, "../../..");
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("development browser signs in with one-time local code and resumes through same-origin session", {
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-dev-browser-"));
  const codeFile = path.join(directory, "code.json");
  const webPort = await freePort();
  const origin = `http://127.0.0.1:${webPort}`;
  const tailnetOrigin = "https://trust-dev.example.ts.net:18447";
  let runtime, vite, browser;
  try {
    runtime = await startRuntime({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "db") },
      accessConfiguration: {
        mode: "local-jwt",
        issuer: `${tailnetOrigin}/auth/dev`,
        audience: "urn:trust:runtime",
        algorithms: ["RS256"],
        tokenProfile: { headerType: "at+jwt" },
        maxTokenAgeSeconds: 120,
      },
      developmentAuthentication: {
        tailnetOrigin,
        users: [{ login: "alice@example.com", subject: "alice-dev", scopes: ["trust.plan.list.own"] }],
        local: { subject: "local-dev", scopes: ["trust.plan.list.own"], codeFile },
        services: [],
      },
      accessResourceUrl: origin + "/mcp",
    });
    vite = spawn(
      process.execPath,
      [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(webPort)],
      {
        cwd: path.join(root, "apps/trust-web"),
        env: { ...process.env, TRUST_RUNTIME_URL: `http://127.0.0.1:${runtime.port}`, TRUST_WEB_PORT: String(webPort) },
        stdio: "ignore",
      },
    );
    let ready = false;
    for (let index = 0; index < 200; index++) {
      try {
        if ((await fetch(origin + "/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "isolated TRUST web must start");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(origin + "/overview");
    await page.getByLabel("One-time development code").waitFor();
    const code = randomBytes(18).toString("base64url");
    await writeFile(
      codeFile,
      JSON.stringify({
        codeHash: createHash("sha256").update(code).digest("hex"),
        expiresAt: Date.now() + 120_000,
      }),
    );
    await page.getByLabel("One-time development code").fill(code);
    const exchange = page.waitForResponse(
      (response) => response.url().endsWith("/auth/dev/token") && response.request().postData()?.includes(code),
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const tokenResponse = await exchange;
    assert.equal(tokenResponse.status(), 200);
    await page.getByRole("button", { name: "Sign out of TRUST" }).waitFor();
    assert.equal(
      await page.evaluate(async () => {
        const response = await fetch("/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plan.list", params: {} }),
        });
        return response.status;
      }),
      401,
      "the browser still sends a Bearer token through the authenticated client",
    );
    await page.reload();
    await page.getByRole("button", { name: "Sign out of TRUST" }).waitFor();
    const storage = await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    assert.doesNotMatch(JSON.stringify(storage), /access_token|refresh_token|eyJ[a-zA-Z0-9_-]+\./);
    await page.getByRole("button", { name: "Sign out of TRUST" }).click();
    await page.getByLabel("One-time development code").waitFor();
    await page.reload();
    await page.getByLabel("One-time development code").waitFor();
  } finally {
    await browser?.close();
    vite?.kill("SIGTERM");
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
