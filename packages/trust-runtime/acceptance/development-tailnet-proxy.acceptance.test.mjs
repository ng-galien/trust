import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startRuntime } from "../dist/src/server.js";

const root = path.resolve(import.meta.dirname, "../../..");
async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function request(port, hostname, origin, login) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      `http://127.0.0.1:${port}/auth/dev/token`,
      {
        method: "POST",
        headers: {
          host: hostname,
          origin,
          "content-type": "application/json",
          ...(login ? { "tailscale-user-login": login } : {}),
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end("{}");
  });
}

test("Tailnet host and identity survive the public web proxy while anonymous access fails closed", {
  timeout: 90000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-dev-proxy-"));
  const webPort = await freePort();
  const tailnetOrigin = "https://trust-dev.example.ts.net:18447";
  let runtime, vite;
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
        local: { subject: "alice-dev", scopes: ["trust.plan.list.own"], codeFile: path.join(directory, "code.json") },
        services: [],
      },
    });
    vite = spawn(
      process.execPath,
      [path.join(root, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(webPort)],
      {
        cwd: path.join(root, "apps/trust-web"),
        env: {
          ...process.env,
          TRUST_RUNTIME_URL: `http://127.0.0.1:${runtime.port}`,
          TRUST_WEB_PORT: String(webPort),
          TRUST_WEB_ALLOWED_HOSTS: "trust-dev.example.ts.net",
        },
        stdio: "ignore",
      },
    );
    let ready = false;
    for (let index = 0; index < 200; index++) {
      try {
        if ((await fetch(`http://127.0.0.1:${webPort}/health`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "web preview must start");
    const host = new URL(tailnetOrigin).host;
    assert.equal((await request(webPort, host, tailnetOrigin)).status, 401);
    assert.equal((await request(webPort, host, tailnetOrigin, "mallory@example.com")).status, 403);
    const accepted = await request(webPort, host, tailnetOrigin, "alice@example.com");
    assert.equal(accepted.status, 200, accepted.body);
    const token = JSON.parse(accepted.body).accessToken;
    const rpc = await fetch(`http://127.0.0.1:${webPort}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plan.list", params: {} }),
    });
    assert.equal(rpc.status, 200);
  } finally {
    vite?.kill("SIGTERM");
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
