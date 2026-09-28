import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRuntimeContainer } from "../dist/src/runtime.js";

test("embedded development authentication grants only configured Tailnet and one-time local identities", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-development-auth-"));
  const codeFile = path.join(directory, "local-code.json");
  const serviceSecretFile = path.join(directory, "service.secret");
  const tailnetOrigin = "https://trust-dev.example.ts.net:18447";
  const accessConfiguration = {
    mode: "local-jwt",
    issuer: `${tailnetOrigin}/auth/dev`,
    audience: "urn:trust:runtime",
    algorithms: ["RS256"],
    tokenProfile: { headerType: "at+jwt" },
    maxTokenAgeSeconds: 120,
  };
  const developmentAuthentication = {
    tailnetOrigin,
    users: [{ login: "alice@example.com", subject: "alice-dev", scopes: ["trust.plan.list.own"] }],
    local: { subject: "local-dev", scopes: ["trust.plan.list.own"], codeFile },
    services: [
      {
        clientId: "service-alice",
        subject: "agent-alice-dev",
        scopes: ["trust.plan.list.own"],
        secretFile: serviceSecretFile,
      },
    ],
  };
  const container = await createRuntimeContainer({
    accessConfiguration,
    developmentAuthentication,
    storage: { kind: "pglite", directory: path.join(directory, "db") },
  });
  const server = createServer(container.resolve("httpApp"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const rpc = (token) =>
    fetch(`${endpoint}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plan.list", params: {} }),
    });
  const remote = (login, origin = tailnetOrigin) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        `${endpoint}/auth/dev/token`,
        {
          method: "POST",
          headers: {
            origin,
            host: new URL(tailnetOrigin).host,
            "content-type": "application/json",
            ...(login ? { "tailscale-user-login": login } : {}),
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
        },
      );
      request.on("error", reject);
      request.end("{}");
    });
  const local = (body, cookie) =>
    fetch(`${endpoint}/auth/dev/token`, {
      method: "POST",
      headers: { origin: endpoint, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await rpc()).status, 401);
    const missingIdentity = await remote();
    assert.equal(missingIdentity.status, 401, await missingIdentity.text());
    assert.equal((await remote("mallory@example.com")).status, 403);
    assert.equal((await remote("alice@example.com", "https://other.example")).status, 403);
    const granted = await remote("alice@example.com");
    assert.equal(granted.status, 200);
    const remoteToken = (await granted.json()).accessToken;
    assert.equal((await rpc(remoteToken)).status, 200);

    const serviceSecret = randomBytes(32).toString("base64url");
    await writeFile(serviceSecretFile, serviceSecret + "\n");
    const service = (secret, headers = {}) =>
      fetch(`${endpoint}/auth/dev/service-token`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ clientId: "service-alice", secret }),
      });
    assert.equal((await service("wrong")).status, 401);
    assert.equal((await service(serviceSecret, { origin: endpoint })).status, 403);
    const serviceResponse = await service(serviceSecret);
    assert.equal(serviceResponse.status, 200);
    const serviceToken = (await serviceResponse.json()).accessToken;
    assert.equal((await rpc(serviceToken)).status, 200);
    assert.equal(JSON.parse(Buffer.from(serviceToken.split(".")[1], "base64url")).sub, "agent-alice-dev");

    const code = randomBytes(18).toString("base64url");
    await writeFile(
      codeFile,
      JSON.stringify({
        codeHash: createHash("sha256").update(code).digest("hex"),
        expiresAt: Date.now() + 120_000,
      }),
    );
    assert.equal((await local({ code: "wrong" })).status, 401);
    const exchange = await local({ code });
    assert.equal(exchange.status, 200);
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("trust_dev_session="));
    const localToken = (await exchange.json()).accessToken;
    assert.equal((await rpc(localToken)).status, 200);
    assert.equal((await local({ code })).status, 401);
    assert.equal((await local({}, cookie)).status, 200);
    const logout = await fetch(`${endpoint}/auth/dev/logout`, {
      method: "POST",
      headers: { origin: endpoint, cookie },
    });
    assert.equal(logout.status, 204);
    assert.equal((await local({}, cookie)).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await container.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
