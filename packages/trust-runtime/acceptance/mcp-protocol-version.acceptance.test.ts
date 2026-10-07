import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll } from "vitest";
import { test } from "./support/fixtures.js";

/* The MCP revisions the runtime declares on `POST /mcp`: `initialize` negotiates one of them, every later request
   names one of them in its `MCP-Protocol-Version` header, and `serverInfo` carries the package version. */

// The file runs compiled from dist/acceptance or directly as TypeScript from acceptance; both use the built runtime.
const here = path.dirname(fileURLToPath(import.meta.url));
const runtimePackage = path.resolve(here, here.endsWith(`${path.sep}dist${path.sep}acceptance`) ? "../.." : "..");
const { startPublicRuntime } = (await import(
  pathToFileURL(path.join(runtimePackage, "dist/acceptance/support/runtime-process.js")).href
)) as typeof import("./support/runtime-process.js");

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26"];

let runtime: Awaited<ReturnType<typeof startPublicRuntime>>;
let runtimeVersion: string;

beforeAll(async () => {
  runtime = await startPublicRuntime("trust-mcp-protocol-version-");
  runtimeVersion = (
    JSON.parse(await readFile(path.join(runtimePackage, "package.json"), "utf8")) as { version: string }
  ).version;
});

afterAll(async () => {
  await runtime?.close();
});

interface Reply {
  readonly status: number;
  readonly body: {
    readonly result?: { readonly protocolVersion?: string; readonly serverInfo?: { name: string; version: string } };
    readonly error?: { readonly code: number; readonly message: string };
  };
}

const post = async (message: unknown, protocolVersion?: string): Promise<Reply> => {
  const response = await fetch(`${runtime.endpoint}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(protocolVersion === undefined ? {} : { "mcp-protocol-version": protocolVersion }),
    },
    body: JSON.stringify(message),
  });
  return { status: response.status, body: (await response.json()) as Reply["body"] };
};

const initialize = (protocolVersion: string) =>
  post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "acceptance", version: "1" } },
  });

const tools = (protocolVersion?: string) =>
  post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, protocolVersion);

test("initialize answers with the requested MCP revision when the runtime speaks it and with the latest one otherwise", async () => {
  for (const revision of SUPPORTED) {
    const reply = await initialize(revision);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.result?.protocolVersion, revision);
  }
  const unknown = await initialize("1999-01-01");
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.result?.protocolVersion, "2025-11-25");
  const older = await initialize("2024-11-05");
  assert.equal(older.body.result?.protocolVersion, "2025-11-25");
});

test("initialize names the runtime and the version of its package", async () => {
  const reply = await initialize("2025-11-25");
  assert.deepEqual(reply.body.result?.serverInfo, { name: "trust-runtime", version: runtimeVersion });
  assert.match(runtimeVersion, /^\d+\.\d+\.\d+/);
});

test("a request whose MCP-Protocol-Version header names another revision, or has none, is refused with 400 and the supported list", async () => {
  for (const header of ["1999-01-01", "2024-11-05", ""]) {
    const refused = await tools(header);
    assert.equal(refused.status, 400, header);
    assert.equal(refused.body.error?.code, -32_600);
    assert.equal(refused.body.error?.message, `MCP-Protocol-Version must be one of ${SUPPORTED.join(", ")}`);
  }
  const absent = await tools();
  assert.equal(absent.status, 400);
  const stream = await fetch(`${runtime.endpoint}/mcp`, {
    headers: { accept: "text/event-stream", "mcp-protocol-version": "2024-11-05" },
  });
  assert.equal(stream.status, 400);
  for (const revision of SUPPORTED) {
    const accepted = await tools(revision);
    assert.equal(accepted.status, 200, revision);
    assert.equal(accepted.body.error, undefined);
  }
});
