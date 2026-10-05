import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SourceTemplate } from "@trust/extension-sdk";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { test } from "./support/fixtures.js";
import { startPublicRuntime } from "./support/runtime-process.js";

type Envelope = { result?: unknown; error?: { message: string } };
type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };

async function request(endpoint: string, transport: "rpc" | "mcp", method: string, params: unknown) {
  const response = await fetch(`${endpoint}/${transport}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Envelope;
}

async function rpc<T>(endpoint: string, method: string, params: unknown): Promise<T> {
  const envelope = await request(endpoint, "rpc", method, params);
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  return envelope.result as T;
}

async function mcp<T>(endpoint: string, name: string, args: unknown): Promise<T> {
  const envelope = await request(endpoint, "mcp", "tools/call", { name, arguments: args });
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  const result = envelope.result as ToolResult;
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text!) as T;
}

async function rejected(endpoint: string, action: string, params: unknown) {
  const envelope = await request(endpoint, "rpc", `template.${action}`, params);
  assert.ok(envelope.error, `RPC template.${action} accepted invalid data: ${JSON.stringify(params)}`);
  const tool = await request(endpoint, "mcp", "tools/call", {
    name: `trust_template_${action}`,
    arguments: params,
  });
  assert.equal(tool.error, undefined, JSON.stringify(tool.error));
  assert.equal((tool.result as ToolResult).isError, true, `MCP template ${action} accepted invalid data`);
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "trust-templates-"));
  const options = {
    storage: { kind: "pglite" as const, directory: path.join(directory, "pglite") },
    operationsDirectory: directory,
  };
  let runtime = await startPublicRuntime("trust-template-process-", options);
  return {
    get endpoint() {
      return runtime.endpoint;
    },
    async restart() {
      await runtime.close();
      runtime = await startPublicRuntime("trust-template-process-", options);
    },
    async close() {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const draft = {
  id: "team-review",
  title: "Team review",
  description: "Reusable review instructions, independent of any policy or Procedure syntax.",
  body: "# {{title}}\n\nReview {{subject}}.\nKeep `scope | unchanged` and ${literal}.\nReturn to {{subject}}.\n",
  parameters: [
    { name: "title", description: "Review title", defaultValue: "Review" },
    { name: "subject", description: "Subject to inspect" },
  ],
  expectedRevision: 0,
};

test("text templates survive restart and expose the same CRUD and literal rendering through RPC and MCP", async () => {
  const runtime = await fixture();
  try {
    assert.deepEqual(await rpc(runtime.endpoint, "template.list", {}), []);
    assert.deepEqual(await mcp(runtime.endpoint, "trust_template_list", {}), []);
    const before = await rpc(runtime.endpoint, "procedure.list", {});
    const jsonBody = '{"request":{"metadata":{"enabled":true}}}';
    const jsonTemplate = await rpc<SourceTemplate>(runtime.endpoint, "template.save", {
      id: "json-request",
      title: "JSON request",
      description: "Nested JSON is ordinary template text.",
      body: jsonBody,
      parameters: [],
      expectedRevision: 0,
    });
    assert.deepEqual(
      await mcp(runtime.endpoint, "trust_template_render", {
        id: jsonTemplate.id,
        expectedRevision: jsonTemplate.revision,
        values: {},
      }),
      { source: jsonBody },
    );
    const created = await rpc<SourceTemplate>(runtime.endpoint, "template.save", draft);
    assert.equal(created.revision, 1);
    assert.equal(created.builtIn, false);
    assert.equal(created.body, draft.body);
    assert.deepEqual(await mcp(runtime.endpoint, "trust_template_read", { id: draft.id }), created);
    const listed = await mcp<SourceTemplate[]>(runtime.endpoint, "trust_template_list", {});
    assert.deepEqual(listed, await rpc(runtime.endpoint, "template.list", {}));
    assert.deepEqual(
      listed.find((item) => item.id === draft.id),
      created,
    );

    const input = { id: draft.id, expectedRevision: 1, values: { subject: "{{title}}\n$&" } };
    const materialized = await mcp<{ source: string }>(runtime.endpoint, "trust_template_render", input);
    assert.deepEqual(materialized, {
      source: "# Review\n\nReview {{title}}\n$&.\nKeep `scope | unchanged` and ${literal}.\nReturn to {{title}}\n$&.\n",
    });
    assert.deepEqual(await rpc(runtime.endpoint, "template.render", input), materialized);
    assert.deepEqual(await rpc(runtime.endpoint, "procedure.list", {}), before);
    await runtime.restart();
    assert.deepEqual(await rpc(runtime.endpoint, "template.read", { id: draft.id }), created);
    assert.deepEqual(await mcp(runtime.endpoint, "trust_template_render", input), materialized);

    const updated = await mcp<SourceTemplate>(runtime.endpoint, "trust_template_save", {
      ...draft,
      title: "Updated review",
      expectedRevision: 1,
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.title, "Updated review");
    assert.deepEqual(await rpc(runtime.endpoint, "template.read", { id: draft.id }), updated);
    assert.deepEqual(await mcp(runtime.endpoint, "trust_template_remove", { id: draft.id, expectedRevision: 2 }), {
      removed: true,
    });
    await runtime.restart();
    await rejected(runtime.endpoint, "read", { id: draft.id });
    const remaining = await rpc<SourceTemplate[]>(runtime.endpoint, "template.list", {});
    assert.equal(
      remaining.some((item) => item.id === draft.id),
      false,
    );
    assert.equal(materialized.source.includes("Keep `scope | unchanged` and ${literal}."), true);
    assert.deepEqual(await rpc(runtime.endpoint, "procedure.list", {}), before);
  } finally {
    await runtime.close();
  }
});

test("template validation rejects malformed declarations and invalid values without changing saved content", async () => {
  const runtime = await fixture();
  try {
    const created = await rpc<SourceTemplate>(runtime.endpoint, "template.save", draft);
    for (const invalid of [
      { parameters: [] },
      { parameters: [...draft.parameters, { name: "unused", description: "Not in source" }] },
      { parameters: [...draft.parameters, draft.parameters[0]] },
      { body: "{{bad-name}}", parameters: [{ name: "bad-name", description: "Invalid identifier" }] },
      { body: "{{subject", parameters: [{ name: "subject", description: "Unclosed placeholder" }] },
      { body: "{{}}", parameters: [] },
      { body: "{{ subject }}", parameters: [{ name: "subject", description: "Malformed placeholder" }] },
    ]) {
      await rejected(runtime.endpoint, "save", { ...draft, ...invalid, expectedRevision: 1 });
      assert.deepEqual(await rpc(runtime.endpoint, "template.read", { id: draft.id }), created);
    }
    for (const values of [{}, { subject: "allowed", extra: "unknown" }, { subject: 42 }]) {
      await rejected(runtime.endpoint, "render", { id: draft.id, expectedRevision: 1, values });
    }
    assert.deepEqual(
      await rpc(runtime.endpoint, "template.render", { id: draft.id, expectedRevision: 1, values: { subject: "" } }),
      { source: draft.body.replaceAll("{{title}}", "Review").replaceAll("{{subject}}", "") },
    );
    assert.deepEqual(await rpc(runtime.endpoint, "template.read", { id: draft.id }), created);
  } finally {
    await runtime.close();
  }
});

test("template revisions prevent stale writes, deletion and rendering across clients", async () => {
  const runtime = await fixture();
  try {
    await rpc(runtime.endpoint, "template.save", draft);
    await rejected(runtime.endpoint, "save", draft);
    const updated = await mcp<SourceTemplate>(runtime.endpoint, "trust_template_save", {
      ...draft,
      body: `${draft.body}New invariant.\n`,
      expectedRevision: 1,
    });
    await rejected(runtime.endpoint, "save", { ...draft, expectedRevision: 1 });
    await rejected(runtime.endpoint, "remove", { id: draft.id, expectedRevision: 1 });
    await rejected(runtime.endpoint, "render", { id: draft.id, expectedRevision: 1, values: { subject: "code" } });
    assert.deepEqual(await rpc(runtime.endpoint, "template.read", { id: draft.id }), updated);
    const rendered = await rpc<{ source: string }>(runtime.endpoint, "template.render", {
      id: draft.id,
      expectedRevision: updated.revision,
      values: { subject: "code", title: "Explicit title" },
    });
    assert.ok(rendered.source.startsWith("# Explicit title\n"));
    assert.ok(rendered.source.endsWith("New invariant.\n"));
  } finally {
    await runtime.close();
  }
});

test("an empty catalog accepts user templates whose copies preserve the original", async () => {
  const runtime = await fixture();
  try {
    assert.deepEqual(await rpc(runtime.endpoint, "template.list", {}), []);
    const original = await rpc<SourceTemplate>(runtime.endpoint, "template.save", draft);
    const clone = await mcp<SourceTemplate>(runtime.endpoint, "trust_template_save", {
      ...draft,
      id: "team-copy",
      expectedRevision: 0,
    });
    assert.equal(clone.builtIn, false);
    const values = { subject: "Team decision" };
    const rendered = await rpc(runtime.endpoint, "template.render", {
      id: original.id,
      expectedRevision: original.revision,
      values,
    });
    assert.deepEqual(
      await mcp(runtime.endpoint, "trust_template_render", {
        id: clone.id,
        expectedRevision: clone.revision,
        values,
      }),
      rendered,
    );
    const edited = await rpc<SourceTemplate>(runtime.endpoint, "template.save", {
      ...draft,
      id: clone.id,
      title: "Edited copy",
      body: `${draft.body}Copy only.`,
      expectedRevision: clone.revision,
    });
    assert.deepEqual(await mcp(runtime.endpoint, "trust_template_read", { id: original.id }), original);
    await rpc(runtime.endpoint, "template.remove", { id: clone.id, expectedRevision: edited.revision });
    assert.deepEqual(await mcp(runtime.endpoint, "trust_template_read", { id: original.id }), original);
    await runtime.restart();
    assert.deepEqual(await rpc(runtime.endpoint, "template.list", {}), [original]);
  } finally {
    await runtime.close();
  }
});

test("recreating a deleted template does not let stale clients mutate or render the replacement", async () => {
  const runtime = await fixture();
  try {
    const original = await rpc<SourceTemplate>(runtime.endpoint, "template.save", draft);
    await rpc(runtime.endpoint, "template.remove", { id: draft.id, expectedRevision: original.revision });
    const replacement = await mcp<SourceTemplate>(runtime.endpoint, "trust_template_save", {
      ...draft,
      title: "Replacement review",
    });
    assert.ok(replacement.revision > original.revision);
    await rejected(runtime.endpoint, "save", { ...draft, expectedRevision: original.revision });
    await rejected(runtime.endpoint, "remove", { id: draft.id, expectedRevision: original.revision });
    await rejected(runtime.endpoint, "render", {
      id: draft.id,
      expectedRevision: original.revision,
      values: { subject: "old client" },
    });
    assert.deepEqual(await rpc(runtime.endpoint, "template.read", { id: draft.id }), replacement);
  } finally {
    await runtime.close();
  }
});

test("template render size checks the final text after all substitutions", async () => {
  const runtime = await fixture();
  try {
    const input = {
      id: "large-output",
      title: "Large output",
      description: "Empty substitutions can shrink a large intermediate string.",
      body: "{{a}}".repeat(4) + "{{b}}".repeat(100),
      parameters: [
        { name: "a", description: "Expanded content" },
        { name: "b", description: "Empty content" },
      ],
      expectedRevision: 0,
    };
    const saved = await rpc<SourceTemplate>(runtime.endpoint, "template.save", input);
    const values = { a: "x".repeat(250_000), b: "" };
    const request = { id: saved.id, expectedRevision: saved.revision, values };
    const rendered = await rpc<{ source: string }>(runtime.endpoint, "template.render", request);
    assert.equal(rendered.source, "x".repeat(1_000_000));
    assert.deepEqual(await mcp(runtime.endpoint, "trust_template_render", request), rendered);
    const larger = await rpc<SourceTemplate>(runtime.endpoint, "template.save", {
      ...input,
      body: `${input.body}!`,
      expectedRevision: saved.revision,
    });
    await rejected(runtime.endpoint, "render", { ...request, expectedRevision: larger.revision });
  } finally {
    await runtime.close();
  }
});

test("public LSP and RPC/MCP reject the same incomplete template definitions", async ({ onTestFinished }) => {
  const runtime = await fixture();
  onTestFinished(() => runtime.close());
  const server = spawn(
    process.execPath,
    [new URL("../../../trust-language-server/bin/trust-language-server.js", import.meta.url).pathname, "--stdio"],
    { stdio: "pipe" },
  );
  const connection = createMessageConnection(
    new StreamMessageReader(server.stdout),
    new StreamMessageWriter(server.stdin),
  );
  onTestFinished(() => {
    connection.dispose();
    if (server.exitCode === null) server.kill("SIGTERM");
  });
  connection.listen();
  await connection.sendRequest("initialize", { processId: null, rootUri: null, capabilities: {} });
  await connection.sendNotification("initialized", {});
  const body =
    "Given Procedure scope\n  | check | authorized | forbidden |\n  | all | Read the repository. | Change state. |\n";
  const cases = [
    { body, parameters: [{ name: "unused", description: "Unused", defaultValue: "x" }] },
    { body: body.replace("repository", "{{target}}"), parameters: [] },
    { body: body.replace("repository", "{{target"), parameters: [] },
  ];
  for (const [index, definition] of cases.entries()) {
    const uri = `inmemory://trust/templates/parity-${index}.feature`;
    await connection.sendNotification("trust/templateContext", { uri, parameters: definition.parameters });
    const messages = new Promise<Array<{ message: string; severity: number }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        listener.dispose();
        reject(new Error("Missing public LSP diagnostics"));
      }, 5000);
      const listener = connection.onNotification(
        "textDocument/publishDiagnostics",
        (value: { uri: string; diagnostics: Array<{ message: string; severity: number }> }) => {
          if (value.uri === uri) {
            clearTimeout(timer);
            listener.dispose();
            resolve(value.diagnostics);
          }
        },
      );
    });
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "trust-procedure", version: 1, text: definition.body },
    });
    const errors = await messages;
    const input = {
      id: `parity-${index}`,
      title: "Parity fixture",
      description: "",
      expectedRevision: 0,
      ...definition,
    };
    const saved = await request(runtime.endpoint, "rpc", "template.save", input);
    assert.ok(saved.error, "Invalid source must not persist");
    assert.ok(
      errors.some(({ severity, message }) => severity === 1 && message === saved.error?.message),
      JSON.stringify({ errors, saved }),
    );
    await rejected(runtime.endpoint, "save", input);
  }
  assert.deepEqual(await rpc(runtime.endpoint, "template.list", {}), []);
  const tools = await request(runtime.endpoint, "mcp", "tools/list", {});
  assert.equal(tools.error, undefined);
  const descriptions = (
    tools.result as {
      tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }>;
    }
  ).tools.filter(({ name }) => name.startsWith("trust_template_"));
  assert.equal(descriptions.length, 5);
  assert.ok(descriptions.every(({ description }) => !/built.in/i.test(description)));
  assert.ok(descriptions.find(({ name }) => name === "trust_template_list")?.description.includes("starts empty"));
  const saveSchema = descriptions.find(({ name }) => name === "trust_template_save")?.inputSchema.properties;
  assert.ok(saveSchema);
  assert.deepEqual(saveSchema.body, { type: "string", minLength: 1, maxLength: 250000 });
  assert.deepEqual(saveSchema.parameters, {
    type: "array",
    maxItems: 64,
    items: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$", maxLength: 96 },
        description: { type: "string", maxLength: 2000 },
        defaultValue: { type: "string", maxLength: 250000 },
      },
      required: ["name", "description"],
      additionalProperties: false,
    },
  });
  assert.deepEqual(descriptions.find(({ name }) => name === "trust_template_render")?.inputSchema.properties.values, {
    type: "object",
    additionalProperties: { type: "string", maxLength: 250000 },
  });
});
