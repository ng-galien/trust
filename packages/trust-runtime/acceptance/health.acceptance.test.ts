import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startPublicRuntime } from "./support/runtime-process.js";

const SOCKET_TIMEOUT_MS = 2_000;

test("the built runtime exposes its public health boundary", async (context) => {
  const running = await startPublicRuntime("trust-health-");
  context.after(() => running.close());

  const response = await fetch(`${running.endpoint}/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.service, "trust-runtime");
  assert.match(String(body.currentTime), /^\d{4}-\d{2}-\d{2}T/);
});

test("an embedded LSP exit notification does not terminate the public runtime", async (context) => {
  const running = await startPublicRuntime("trust-lsp-lifecycle-");
  context.after(() => running.close());
  const socket = new WebSocket(`${running.endpoint.replace("http://", "ws://")}/lsp`);
  context.after(() => socket.close());
  await socketEvent(socket, "open");

  socket.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { processId: null, rootUri: null, capabilities: {} },
  }));
  await response(socket, 1);
  socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }));
  await response(socket, 2);
  const closed = socketEvent(socket, "close");
  socket.send(JSON.stringify({ jsonrpc: "2.0", method: "exit", params: null }));
  await closed;

  const health = await fetch(`${running.endpoint}/health`);
  assert.equal(health.status, 200);
});

async function socketEvent(socket: WebSocket, event: "open" | "close"): Promise<void> {
  await once(socket, event, { signal: AbortSignal.timeout(SOCKET_TIMEOUT_MS) });
}

function response(socket: WebSocket, id: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`LSP response ${id} timed out`)), SOCKET_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const finish = (error: Error | undefined, result?: unknown): void => {
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onMessage = (data: WebSocket.RawData): void => {
      let message: { id?: number; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (message.id !== id) return;
      if (message.error !== undefined) finish(new Error(JSON.stringify(message.error)));
      else finish(undefined, message.result);
    };
    const onClose = (): void => finish(new Error(`LSP connection closed before response ${id}`));
    const onError = (error: Error): void => finish(error);
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}
