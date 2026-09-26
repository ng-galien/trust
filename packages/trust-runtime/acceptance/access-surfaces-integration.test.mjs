import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import {
  createAccessTestProvider,
  DEVELOPMENT_INTROSPECTION_RESOURCE,
} from "../../../environments/trust-test/auth/provider.mjs";
import { startRuntime } from "../dist/src/server.js";
import { engage, resources, root, rpc, scopes, seed } from "./access-ownership-support.mjs";
import { sharedTrialJourney } from "./access-surfaces-trial-support.mjs";

test("SURFACE-TRANSPORT streams and WebSocket enforce the shared access authority", { timeout: 120000 }, async () => {
  await sharedTrialJourney();
  await onlineWithdrawal();
  const directory = await mkdtemp(path.join(tmpdir(), "trust-access-surfaces-"));
  const provider = await createAccessTestProvider();
  let runtime;
  const sockets = [];
  const abort = new AbortController();
  try {
    runtime = await startRuntime({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "data") },
      operationsDirectory: path.join(root, "assets/operations"),
      accessConfiguration: provider.configuration,
      accessResourceUrl: "http://127.0.0.1/mcp",
    });
    const endpoint = `http://127.0.0.1:${runtime.port}`;
    const [alice, bob, admin] = await Promise.all([
      provider.issue({ subject: "alice", scope: scopes().join(" ") }),
      provider.issue({ subject: "bob", scope: scopes().join(" ") }),
      provider.issue({
        subject: "admin",
        scope: [
          ...scopes("all"),
          ...resources,
          "trust.operation.read",
          "trust.operation.compile",
          "trust.procedure.compile",
          "trust.extension.list",
        ].join(" "),
      }),
    ]);
    await seed(endpoint, admin.token);
    await assert.rejects(
      startRuntime({
        host: "127.0.0.1",
        port: 0,
        accessConfiguration: provider.configuration,
        diagnosticsEndpoint: "https://untrusted.example/collect",
      }),
      /this runtime's origin/,
    );
    const engageOnly = await provider.issue({ subject: "alice", scope: "trust.plan.engage.own" });
    const mcp = await fetch(endpoint + "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${engageOnly.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "trust_plan_engage",
          arguments: {
            procedure: "git-status",
            procedureVersion: "2.0.0",
            plan: "mcp-no-extra-read",
            environment: "local",
            rootInputs: { repository: "repository" },
          },
        },
      }),
    });
    const engaged = await mcp.json();
    assert.notEqual(engaged.result?.isError, true);
    assert.match(JSON.stringify(engaged.result), /engaged/);

    for (const route of [
      "/rpc",
      "/mcp",
      "/v1/traces",
      "/events/plans",
      "/extensions",
      "/otlp/diagnostics/trials/nope/stream",
    ])
      assert.equal((await fetch(endpoint + route)).status, 401, route);
    assert.equal((await fetch(endpoint + "/rpc?access_token=forbidden")).status, 400);
    assert.equal(
      (
        await fetch(endpoint + "/mcp", {
          headers: { authorization: `Bearer ${admin.token}`, origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    const metadata = await (await fetch(endpoint + "/.well-known/oauth-protected-resource/mcp")).json();
    assert.deepEqual(metadata.authorization_servers, [provider.issuer]);
    const publicConfig = await (await fetch(endpoint + "/auth/config")).json();
    assert.deepEqual(publicConfig, { required: true, browser: null });
    const stream = await fetch(endpoint + "/events/plans", {
      signal: abort.signal,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    let observed = "";
    const reading = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          observed += Buffer.from(value).toString();
        }
      } catch {}
    })();
    await rpc(endpoint, bob.token, "plan.engage", engage("foreign-stream-plan"));
    await rpc(endpoint, alice.token, "plan.engage", engage("own-stream-plan"));
    for (let i = 0; i < 100 && !observed.includes("own-stream-plan"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(observed, /own-stream-plan/);
    assert.doesNotMatch(observed, /foreign-stream-plan/);
    abort.abort();
    await reading;
    const sessionOnly = await provider.issue({ subject: "alice", scope: "trust.session.read.own" });
    assert.equal(
      (await rpc(endpoint, sessionOnly.token, "session.read", { plan: "own-stream-plan" })).plan,
      "own-stream-plan",
    );
    const denied = new WebSocket(endpoint.replace("http:", "ws:") + "/lsp");
    sockets.push(denied);
    denied.on("error", () => {});
    const refusal = await once(denied, "unexpected-response");
    assert.equal(refusal[1].statusCode, 403);
    refusal[1].resume();
    denied.terminate();
    const encoded = Buffer.from(admin.token).toString("base64url");
    const socket = new WebSocket(endpoint.replace("http:", "ws:") + "/lsp", ["trust-lsp", `bearer.${encoded}`]);
    sockets.push(socket);
    await once(socket, "open");
    assert.equal(socket.protocol, "trust-lsp", "credential protocol must not be reflected");
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { processId: null, rootUri: null, capabilities: {} },
      }),
    );
    const [message] = await once(socket, "message");
    const initialized = JSON.parse(message.toString());
    assert.equal(initialized.id, 1);
    assert.ok(initialized.result.capabilities);
  } finally {
    abort.abort();
    for (const socket of sockets) socket.terminate();
    await runtime?.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function onlineWithdrawal() {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-online-surfaces-"));
  const provider = await createAccessTestProvider();
  let runtime, socket;
  const abort = new AbortController();
  try {
    runtime = await startRuntime({
      host: "127.0.0.1",
      port: 0,
      storage: { kind: "pglite", directory: path.join(directory, "data") },
      operationsDirectory: path.join(root, "assets/operations"),
      accessConfiguration: {
        mode: "introspection",
        issuer: provider.issuer,
        audience: provider.configuration.audience,
        allowInsecureLoopback: true,
        introspection: {
          clientId: "trust-introspection",
          clientSecretReference: { environment: "test", name: "introspection" },
          authenticationMethod: "client_secret_post",
        },
      },
      accessSecretResolver: () => provider.secrets["trust-introspection"],
    });
    const endpoint = `http://127.0.0.1:${runtime.port}`;
    const admin = await provider.issue({
      subject: "admin",
      scope: [...scopes("all"), ...resources].join(" "),
      resource: DEVELOPMENT_INTROSPECTION_RESOURCE,
    });
    await seed(endpoint, admin.token);
    const alice = await provider.issue({
      subject: "alice",
      scope: "trust.plan.read.own",
      resource: DEVELOPMENT_INTROSPECTION_RESOURCE,
    });
    const stream = await fetch(endpoint + "/events/plans", {
      signal: abort.signal,
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    let initial = "";
    while (!initial.includes("runtime.changed")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      initial += Buffer.from(chunk.value).toString();
    }
    await provider.revoke(alice);
    await rpc(endpoint, admin.token, "plan.engage", engage("trigger-after-withdrawal"));
    const ended = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(Error("revoked stream stayed open")), 3000).unref()),
    ]);
    assert.equal(ended.done, true, "revoked online stream closes before another event");
    const lsp = await provider.issue({
      subject: "admin",
      scope: "trust.procedure.read trust.procedure.compile trust.operation.read trust.operation.compile",
      resource: DEVELOPMENT_INTROSPECTION_RESOURCE,
    });
    socket = new WebSocket(endpoint.replace("http:", "ws:") + "/lsp", {
      headers: { authorization: `Bearer ${lsp.token}` },
    });
    await once(socket, "open");
    await provider.revoke(lsp);
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } }));
    assert.equal((await closed)[0], 1008, "subsequent LSP message revalidates online credential");
  } finally {
    abort.abort();
    socket?.terminate();
    await runtime?.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
}
