import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createRuntimeContainer } from "../dist/src/runtime.js";

/** Controlled signed boundary fixture, not an OAuth login implementation or runtime bypass. */
export async function controlledAuthority() {
  let keys = await generateKeyPair("RS256");
  let kid = "key-1";
  const states = new Map();
  const counts = { discovery: 0, jwks: 0, introspection: 0 };
  const controls = { unavailable: false, issuerMismatch: false, endpointQuery: false };
  const secret = "disposable-introspection-fixture-secret";
  let issuer;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://fixture.invalid").pathname;
      response.setHeader("content-type", "application/json");
      if (controls.unavailable) {
        response.writeHead(503).end("{}");
        return;
      }
      if (
        request.url === "/issuer/.well-known/openid-configuration" ||
        request.url === "/.well-known/oauth-authorization-server/issuer"
      ) {
        counts.discovery++;
        response.end(
          JSON.stringify({
            issuer: controls.issuerMismatch ? `${issuer}/wrong` : issuer,
            jwks_uri: `${issuer}/jwks${controls.endpointQuery ? "?version=1" : ""}`,
            introspection_endpoint: `${issuer}/introspect${controls.endpointQuery ? "?version=1" : ""}`,
            introspection_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          }),
        );
      } else if (pathname === "/issuer/jwks") {
        counts.jwks++;
        response.end(
          JSON.stringify({ keys: [{ ...(await exportJWK(keys.publicKey)), kid, use: "sig", alg: "RS256" }] }),
        );
      } else if (pathname === "/issuer/introspect" && request.method === "POST") {
        counts.introspection++;
        let body = "";
        for await (const chunk of request) body += chunk;
        const params = new URLSearchParams(body);
        const basic = `Basic ${Buffer.from(`trust:${secret}`).toString("base64")}`;
        if (
          request.headers.authorization !== basic &&
          !(params.get("client_id") === "trust" && params.get("client_secret") === secret)
        ) {
          response.writeHead(401).end("{}");
          return;
        }
        response.end(JSON.stringify(states.get(params.get("token")) ?? { active: false }));
      } else response.writeHead(404).end("{}");
    } catch {
      response.writeHead(500).end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  issuer = `http://127.0.0.1:${server.address().port}/issuer`;
  return {
    issuer,
    counts,
    controls,
    states,
    secret,
    configuration: { mode: "local-jwt", issuer, audience: "trust", allowInsecureLoopback: true },
    introspectionConfiguration: {
      mode: "introspection",
      issuer,
      audience: "trust",
      allowInsecureLoopback: true,
      introspection: { clientId: "trust", clientSecretReference: { environment: "test", name: "introspection" } },
    },
    async issue({ subject = "alice", scope = "trust.environment.list", claims = {}, header = {} } = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: issuer,
        sub: subject,
        aud: "trust",
        iat: now,
        exp: now + 300,
        scope,
        client_id: "fixture",
        jti: randomUUID(),
        ...claims,
      };
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid, typ: "at+jwt", ...header })
        .sign(keys.privateKey);
      states.set(token, { ...payload, active: true, token_type: "Bearer" });
      return token;
    },
    async rotate() {
      keys = await generateKeyPair("RS256");
      kid = `key-${Date.now()}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function authorityRuntime(configuration, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-access-authority-"));
  await mkdir(path.join(directory, "operations"));
  let container;
  try {
    container = await createRuntimeContainer({
      storage: { kind: "pglite", directory: path.join(directory, "database") },
      operationsDirectory: path.join(directory, "operations"),
      accessConfiguration: configuration,
      ...options,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const server = createServer(container.resolve("httpApp"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint,
    container,
    async rpc(token, method, params = {}) {
      const response = await fetch(`${endpoint}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await container.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
