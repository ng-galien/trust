import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "./support/fixtures.js";

interface McpTool {
  name: string;
  inputSchema: { properties: { command: { enum: string[] } }; oneOf: unknown[] };
  annotations: { readOnlyHint: boolean };
}
/** The MCP response fields these scenarios read. */
interface McpResponse {
  result: {
    capabilities: { tools: { listChanged: boolean } };
    tools: McpTool[];
    content: { type: string; text: string }[];
    isError?: boolean;
  };
}
interface ExtensionEntry {
  id: string;
  state: string;
}
interface ToolContent {
  extension: ExtensionEntry;
  extensions: ExtensionEntry[];
  error: string;
}

async function readStream(stream: Response) {
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  if (!stream.body) throw new Error("The event stream has no body");
  return stream.body.getReader();
}

test("one extension MCP tool shares declared commands with HTTP and announces running catalog changes", {
  timeout: 30_000,
}, async ({ startRuntime }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-commands-"));
  await writeFile(
    path.join(directory, "server.mjs"),
    `
export function createExtension() {
  let calls = 0;
  return {
    async prepare() {}, async start() {}, async stop() {}, async read() { return {status:200,body:{calls}}; },
    async command({command,arguments:args}) {
      if (command === 'records.fail') throw new Error('private-secret-stack');
      if (command === 'records.crash') process.exit(1);
      if (command === 'records.hang') return new Promise(() => {});
      if (command === 'records.block') for (;;) {}
      if (Object.keys(args).length !== 1 || !Number.isInteger(args.value)) return {status:400,body:{error:'invalid-value'},text:'Value must be an integer.'};
      return {status:200,body:{value:args.value,calls:++calls},text:'Recorded value '+args.value+'.'};
    }
  };
}`,
  );
  const commands = ["records.save", "records.fail", "records.crash", "records.hang", "records.block"].map((name) => ({
    name,
    description: name,
    inputSchema: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false,
    },
    readOnly: false,
  }));
  const manifest = path.join(directory, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      contract: "trust.extension@1",
      id: "sample-extension",
      title: "Sample",
      version: "1",
      server: "./server.mjs",
      configuration: {},
      requestedCapabilities: [],
      mcp: { description: "Manage sample records.", commands },
    }),
  );
  const registry = path.join(directory, "registry.json");
  await writeFile(
    registry,
    JSON.stringify({ extensions: [{ manifest, configuration: {}, environment: "local", grants: [] }] }),
  );
  const runtime = await startRuntime("trust-extension-command-runtime-", {
    extensionsFile: registry,
    processEnvironment: { TRUST_EXTENSION_TIMEOUT_MS: "1500" },
  });
  const headers = { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" };
  const rpc = async (method: string, params?: unknown) => {
    const response = await fetch(`${runtime.endpoint}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await response.json()) as McpResponse;
  };
  const post = (suffix: string, body: unknown = {}) =>
    fetch(`${runtime.endpoint}/extensions/sample-extension/${suffix}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const call = (args: unknown) => rpc("tools/call", { name: "trust_extension_sample_extension", arguments: args });
  const catalog = async () => (await rpc("tools/list")).result.tools;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const core = await catalog();
    assert.equal(
      core.some((tool) => tool.name === "trust_extension_sample_extension"),
      false,
    );
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1" },
    });
    assert.equal(initialized.result.capabilities.tools.listChanged, true);
    assert.equal(
      (
        await fetch(`${runtime.endpoint}/mcp`, {
          headers: { accept: "application/json", "mcp-protocol-version": "2025-03-26" },
        })
      ).status,
      406,
    );
    const stream = await fetch(`${runtime.endpoint}/mcp`, {
      headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-03-26" },
    });
    const events = await readStream(stream);
    reader = events;
    const next = async () => new TextDecoder().decode((await events.read()).value);
    assert.match(await next(), /connected/);
    assert.equal((await post("start")).status, 200);
    assert.match(await next(), /event: message\ndata: .*"method":"notifications\/tools\/list_changed"/);
    const listed = await catalog();
    assert.equal(listed.length, core.length + 1);
    const tool = listed.find((tool) => tool.name === "trust_extension_sample_extension");
    assert.ok(tool);
    assert.deepEqual(
      tool.inputSchema.properties.command.enum,
      commands.map((command) => command.name),
    );
    assert.equal(tool.inputSchema.oneOf.length, 5);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal((await post("commands", { command: "records.save", arguments: { value: 7 } })).status, 200);
    const result = await call({ command: "records.save", arguments: { value: 8 } });
    assert.deepEqual(result.result.content, [{ type: "text", text: "Recorded value 8." }]);
    assert.equal(result.result.isError, undefined);
    for (const invalid of [
      { command: "records.save", arguments: {}, extra: true },
      { command: "records.save", arguments: [] },
      { command: "records.unknown", arguments: {} },
      { command: "records.save" },
    ]) {
      assert.equal((await call(invalid)).result.isError, true);
      assert.equal((await post("commands", invalid)).status, 400);
    }
    const invalidArgument = await call({ command: "records.save", arguments: { value: "bad" } });
    assert.equal(invalidArgument.result.isError, true);
    assert.equal(invalidArgument.result.content[0]?.text, "Value must be an integer.");
    assert.deepEqual(await (await post("commands", { command: "records.save", arguments: {} })).json(), {
      error: "invalid-value",
    });
    assert.deepEqual(await (await fetch(`${runtime.endpoint}/extensions/sample-extension/api/count`)).json(), {
      calls: 2,
    });
    const thrown = await call({ command: "records.fail", arguments: {} });
    assert.equal(thrown.result.isError, true);
    assert.doesNotMatch(JSON.stringify(thrown), /private-secret-stack/);
    assert.equal((await post("stop")).status, 200);
    assert.match(await next(), /notifications\/tools\/list_changed/);
    assert.deepEqual(await catalog(), core);
    assert.equal((await call({ command: "records.save", arguments: { value: 9 } })).result.isError, true);
    assert.equal((await post("commands", { command: "records.save", arguments: { value: 9 } })).status, 409);
    await post("start");
    await next();
    assert.equal((await call({ command: "records.crash", arguments: {} })).result.isError, true);
    assert.match(await next(), /notifications\/tools\/list_changed/);
    assert.deepEqual(await catalog(), core);
    await post("start");
    await next();
    // A slow command fails alone and keeps the tool; a frozen process is failed and leaves the catalog.
    assert.equal((await call({ command: "records.hang", arguments: {} })).result.isError, true);
    assert.equal((await catalog()).length, core.length + 1);
    assert.equal((await call({ command: "records.block", arguments: {} })).result.isError, true);
    assert.match(await next(), /notifications\/tools\/list_changed/);
    assert.deepEqual(await catalog(), core);
  } finally {
    await reader?.cancel();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("extension lifecycle MCP tools expose actual states and control only a named installation", {
  timeout: 30_000,
}, async ({ startRuntime }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-lifecycle-mcp-"));
  const healthyServer = path.join(directory, "healthy.mjs");
  const failingServer = path.join(directory, "failing.mjs");
  await writeFile(
    healthyServer,
    "export function createExtension(){return{async prepare(){},async start(){},async stop(){},async read(){return{status:200,body:{ok:true}}}}}",
  );
  await writeFile(
    failingServer,
    "export function createExtension(){return{async prepare(){},async start(){throw new Error('private-start-detail')},async stop(){},async read(){return{status:200,body:{ok:true}}}}}",
  );
  const manifests = [
    { id: "healthy", server: "./healthy.mjs" },
    { id: "failing", server: "./failing.mjs" },
  ];
  for (const entry of manifests)
    await writeFile(
      path.join(directory, `${entry.id}.json`),
      JSON.stringify({
        contract: "trust.extension@1",
        id: entry.id,
        title: entry.id,
        version: "1",
        server: entry.server,
        configuration: {},
        requestedCapabilities: [],
      }),
    );
  const registry = path.join(directory, "registry.json");
  await writeFile(
    registry,
    JSON.stringify({
      extensions: manifests.map((entry) => ({
        manifest: path.join(directory, `${entry.id}.json`),
        configuration: {},
        environment: "local",
        grants: [],
      })),
    }),
  );
  const runtime = await startRuntime("trust-extension-lifecycle-mcp-runtime-", { extensionsFile: registry });
  const rpc = async (name: string, args: object = {}) => {
    const response = await fetch(`${runtime.endpoint}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }),
    });
    return (await response.json()) as McpResponse;
  };
  const content = (response: McpResponse): ToolContent => JSON.parse(response.result.content[0]?.text ?? "null");
  try {
    const listedTools = (await fetch(`${runtime.endpoint}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((response) => response.json())) as McpResponse;
    for (const name of [
      "trust_extensions_list",
      "trust_extension_status",
      "trust_extension_prepare",
      "trust_extension_start",
      "trust_extension_stop",
      "trust_extension_restart",
    ])
      assert.equal(
        listedTools.result.tools.some((tool) => tool.name === name),
        true,
      );
    assert.deepEqual(
      content(await rpc("trust_extensions_list")).extensions.map((entry) => [entry.id, entry.state]),
      [
        ["healthy", "STOPPED"],
        ["failing", "STOPPED"],
      ],
    );
    assert.equal(content(await rpc("trust_extension_prepare", { extension: "healthy" })).extension.state, "STOPPED");
    assert.equal(content(await rpc("trust_extension_start", { extension: "healthy" })).extension.state, "RUNNING");
    assert.equal(content(await rpc("trust_extension_restart", { extension: "healthy" })).extension.state, "RUNNING");
    assert.equal(content(await rpc("trust_extension_stop", { extension: "healthy" })).extension.state, "STOPPED");
    assert.equal(content(await rpc("trust_extension_status", { extension: "healthy" })).extension.state, "STOPPED");
    const failed = await rpc("trust_extension_start", { extension: "failing" });
    assert.equal(failed.result.isError, true);
    assert.equal(content(failed).extension.state, "FAILED");
    assert.doesNotMatch(JSON.stringify(failed), /private-start-detail/);
    assert.equal(content(await rpc("trust_extension_status", { extension: "failing" })).extension.state, "FAILED");
    const missing = await rpc("trust_extension_restart", { extension: "absent" });
    assert.equal(missing.result.isError, true);
    assert.equal(content(missing).error, "extension-not-found");
    assert.equal((await rpc("trust_extension_stop", { extension: "../healthy" })).result.isError, true);
    assert.equal(content(await rpc("trust_extension_status", { extension: "healthy" })).extension.state, "STOPPED");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a declared extension command requires an actual child hook before catalog admission", async ({
  startRuntime,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-missing-command-"));
  await writeFile(
    path.join(directory, "server.mjs"),
    "export function createExtension() { return { async prepare(){}, async start(){}, async stop(){}, async read(){} }; }",
  );
  const manifest = path.join(directory, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      contract: "trust.extension@1",
      id: "missing",
      title: "Missing",
      version: "1",
      server: "./server.mjs",
      configuration: {},
      requestedCapabilities: [],
      mcp: {
        description: "Missing hook",
        commands: [{ name: "records.list", description: "List", inputSchema: { type: "object" }, readOnly: true }],
      },
    }),
  );
  const registry = path.join(directory, "registry.json");
  await writeFile(
    registry,
    JSON.stringify({
      extensions: [{ manifest, configuration: {}, environment: "local", grants: [], autoStart: true }],
    }),
  );
  const runtime = await startRuntime("trust-extension-missing-runtime-", { extensionsFile: registry });
  try {
    const catalog = (await fetch(`${runtime.endpoint}/extensions`).then((response) => response.json())) as {
      extensions: ExtensionEntry[];
    };
    assert.equal(catalog.extensions[0]?.state, "FAILED");
    const result = (await fetch(`${runtime.endpoint}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((response) => response.json())) as McpResponse;
    assert.equal(
      result.result.tools.some((tool) => tool.name === "trust_extension_missing"),
      false,
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid extension command declarations refuse runtime startup", async ({ startRuntime }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-extension-invalid-commands-"));
  await writeFile(
    path.join(directory, "server.mjs"),
    "export function createExtension() { throw new Error('must not load'); }",
  );
  const command = {
    name: "records.list",
    description: "List records",
    inputSchema: { type: "object" },
    readOnly: true,
  };
  const manifest = path.join(directory, "manifest.json");
  const registry = path.join(directory, "registry.json");
  await writeFile(
    registry,
    JSON.stringify({ extensions: [{ manifest, configuration: {}, environment: "local", grants: [] }] }),
  );
  try {
    for (const commands of [
      [],
      [command, command],
      [{ ...command, readOnly: "true" }],
      [{ ...command, inputSchema: { type: "array" } }],
      [{ ...command, name: "arbitrary command" }],
    ]) {
      await writeFile(
        manifest,
        JSON.stringify({
          contract: "trust.extension@1",
          id: "invalid",
          title: "Invalid",
          version: "1",
          server: "./server.mjs",
          configuration: {},
          requestedCapabilities: [],
          mcp: { description: "Invalid declarations", commands },
        }),
      );
      await assert.rejects(
        startRuntime("trust-invalid-command-runtime-", { extensionsFile: registry }),
        /Invalid extension/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
