import type { APIRequestContext } from "@playwright/test";

const runtimeRpcUrl = "http://127.0.0.1:4390/rpc";

/** Drive the isolated acceptance runtime through the same public RPC boundary used by the interface. */
export async function runtimeRpc<Result = unknown>(
  request: APIRequestContext,
  method: string,
  params: unknown,
): Promise<Result> {
  const response = await request.post(runtimeRpcUrl, {
    data: { jsonrpc: "2.0", id: method, method, params },
  });
  const payload = await response.json() as { result?: Result; error?: { message: string } };
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result as Result;
}
