import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import express from "express";
import { createExtensionAssetsHttpHandler } from "../dist/src/http/extension-assets.js";

const root = path.resolve(import.meta.dirname, "../../..");

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function raw(origin, route, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin, { path: route, method }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("EXTENSION-UI confined assets and authenticated transport reject credential forwarding", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-ui-unit-"));
  let assets, api, external;
  const previousWindow = globalThis.window;
  try {
    const bundle = path.join(directory, "bundle");
    await mkdir(bundle);
    await writeFile(path.join(bundle, "remoteEntry.js"), "export const browserBundle=true;");
    await writeFile(path.join(directory, "secret.txt"), "not a public bundle");
    await mkdir(path.join(bundle, "assets"));
    await symlink(path.join(directory, "secret.txt"), path.join(bundle, "assets", "escape.js"));
    await writeFile(path.join(bundle, "assets", "chunk-123.js"), "export const child=true;");
    for (const name of [".env", "private.json", "source.ts", "remoteEntry.js.map", "@mf-types.zip", "server.mjs"])
      await writeFile(path.join(bundle, name), "not a public bundle");
    for (const name of ["server.mjs", "backend.js", "source.js", "data.js"])
      await writeFile(path.join(bundle, "assets", name), "not a public bundle");
    await mkdir(path.join(bundle, "data"));
    await writeFile(path.join(bundle, "data", "payload.js"), "not a public bundle");
    const app = express();
    app.use(
      "/extensions",
      createExtensionAssetsHttpHandler({
        get(id) {
          if (id !== "fixture") throw new Error();
          return { installation: { ui: { assets: bundle, entry: "remoteEntry.js" } } };
        },
      }),
    );
    app.use((_request, response) => response.status(401).end());
    assets = await listen(app);
    assert.equal((await raw(assets.origin, "/extensions/fixture/assets/remoteEntry.js")).status, 200);
    assert.equal((await raw(assets.origin, "/extensions/fixture/assets/assets/chunk-123.js")).status, 200);
    assert.deepEqual(await raw(assets.origin, "/extensions/fixture/assets/remoteEntry.js", "HEAD"), {
      status: 200,
      body: "",
    });
    for (const suffix of [
      "../secret.txt",
      "%2e%2e/secret.txt",
      "%2e%2e%2fsecret.txt",
      "assets/escape.js",
      "missing.js",
      ".env",
      "private.json",
      "source.ts",
      "remoteEntry.js.map",
      "@mf-types.zip",
      "server.mjs",
      "data/payload.js",
      "assets/server.mjs",
      "assets/backend.js",
      "assets/source.js",
      "assets/data.js",
    ]) {
      const response = await raw(assets.origin, `/extensions/fixture/assets/${suffix}`);
      assert.equal(response.status, 404);
      assert.ok(!response.body.includes("not a public bundle"));
    }
    assert.equal((await raw(assets.origin, "/extensions/fixture/assets/remoteEntry.js", "POST")).status, 405);
    assert.equal((await raw(assets.origin, "/extensions/fixture/api/items")).status, 401);
    assert.equal((await raw(assets.origin, "/extensions/fixture/commands", "POST")).status, 401);
    let externalRequests = 0;
    external = await listen((_request, response) => {
      externalRequests++;
      response.end();
    });
    const received = [];
    api = await listen((request, response) => {
      received.push({ path: request.url, bearer: request.headers.authorization, cookie: request.headers.cookie });
      if (request.url.endsWith("/events")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('event: change\ndata: {"resync":true}\n\n');
      } else if (request.url.endsWith("/redirect"))
        response.writeHead(302, { location: external.origin + "/collect" }).end();
      else response.end("{}");
    });
    globalThis.window = { location: { origin: api.origin } };
    const outfile = path.join(directory, "transport.mjs");
    await build({
      entryPoints: [path.join(root, "packages/trust-ui/src/extensions/transport.ts")],
      bundle: true,
      platform: "browser",
      format: "esm",
      outfile,
    });
    const { createExtensionTransport } = await import(outfile);
    let tokensRead = 0;
    const privateBearer = "private-unit-bearer";
    const connection = createExtensionTransport(api.origin, "fixture", {
      async token() {
        tokensRead++;
        return privateBearer;
      },
      async requireLogin() {},
    });
    for (const url of [
      external.origin + "/extensions/fixture/api/items",
      api.origin + "/rpc",
      api.origin + "/extensions/other/api/items",
      api.origin + "/extensions/fixture/api/../commands",
      api.origin + "/extensions/fixture/api/%2e%2e/commands",
      api.origin + "/extensions/fixture/api/a%2fb",
      api.origin + "/extensions/fixture/api/items?access_token=x",
    ])
      await assert.rejects(connection.transport.fetch(url));
    assert.equal(tokensRead, 0, "Rejected destinations must not obtain a token");
    await assert.rejects(
      connection.transport.fetch(api.origin + "/extensions/fixture/api/items", {
        headers: { authorization: "Bearer supplied" },
      }),
    );
    await connection.transport.fetch(api.origin + "/extensions/fixture/api/items");
    assert.equal(received.at(-1).bearer, `Bearer ${privateBearer}`);
    assert.equal(received.at(-1).cookie, undefined);
    await assert.rejects(connection.transport.fetch(api.origin + "/extensions/fixture/api/redirect"));
    assert.equal(externalRequests, 0);
    const stream = connection.transport.openEvents();
    const change = await new Promise((resolve) => stream.addEventListener("change", resolve, { once: true }));
    assert.equal(change.data, '{"resync":true}');
    stream.close();
    assert.equal(received.at(-1).bearer, `Bearer ${privateBearer}`);
    assert.ok(received.every((row) => !row.path.includes(privateBearer)));
    connection.dispose();
    await assert.rejects(connection.transport.fetch(api.origin + "/extensions/fixture/api/items"));
    assert.throws(() => connection.transport.openEvents());
  } finally {
    globalThis.window = previousWindow;
    await assets?.close();
    await api?.close();
    await external?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
