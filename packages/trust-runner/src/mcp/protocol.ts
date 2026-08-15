import type { CheckResult } from "../check/run.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../lib/json.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const TRUST_CHECK_RUN_TOOL = "trust_check_run";

export interface CheckRunner {
  run(checkUri: string): Promise<CheckResult>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: JsonObject;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: JsonValue };
}

export function createMcpHandler(runner: CheckRunner) {
  return async (message: unknown): Promise<JsonRpcResponse | undefined> => {
    if (!isJsonObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return error(null, -32600, "Invalid Request");
    }
    if (message.id === undefined) return undefined;
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    if (id === null) return error(null, -32600, "Invalid Request");
    if (message.method === "initialize") {
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "trust-runner", version: "0.1.0" },
      });
    }
    if (message.method === "ping") return success(id, {});
    if (message.method === "tools/list") {
      return success(id, {
        tools: [{
          name: TRUST_CHECK_RUN_TOOL,
          title: "Run TRUST Check",
          description: "Execute the definition returned by TRUST for one semantic Check URI.",
          inputSchema: {
            type: "object",
            properties: { checkUri: { type: "string" } },
            required: ["checkUri"],
            additionalProperties: false,
          },
        }],
      });
    }
    if (message.method !== "tools/call") return error(id, -32601, "Method not found");
    if (!isJsonObject(message.params) || message.params.name !== TRUST_CHECK_RUN_TOOL) {
      return error(id, -32602, `Unknown tool; expected ${TRUST_CHECK_RUN_TOOL}`);
    }
    const arguments_ = message.params.arguments;
    if (
      !isJsonObject(arguments_)
      || Object.keys(arguments_).length !== 1
      || typeof arguments_.checkUri !== "string"
    ) {
      return error(id, -32602, "Tool accepts exactly one checkUri string");
    }
    try {
      const result = await runner.run(arguments_.checkUri);
      return success(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        ...(result.status === "REFUSED" ? { isError: true } : {}),
      });
    } catch (cause) {
      return success(id, {
        content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
        isError: true,
      });
    }
  };
}

export function parseError(): JsonRpcResponse {
  return error(null, -32700, "Parse error");
}

function success(id: string | number, result: JsonObject): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
