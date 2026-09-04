export interface TrustRpcClientOptions {
  readonly url: string;
  readonly timeoutMilliseconds?: number;
}

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: string | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export class TrustRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "TrustRpcError";
  }
}

export async function callTrustRpc(
  options: TrustRpcClientOptions,
  method: string,
  params: unknown,
): Promise<unknown> {
  const endpoint = rpcEndpoint(options.url);
  const id = `trust-cli:${method}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(options.timeoutMilliseconds ?? 30_000),
    });
  } catch (error) {
    throw new Error(
      `TRUST server is unavailable at ${endpoint.origin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new Error(`TRUST server returned HTTP ${response.status}`);

  let envelope: unknown;
  try {
    envelope = await response.json() as unknown;
  } catch {
    throw new Error("TRUST server returned an invalid JSON-RPC response");
  }
  if (!isRpcEnvelope(envelope, id)) {
    throw new Error("TRUST server returned an invalid JSON-RPC response");
  }
  if ("error" in envelope) {
    const detail = registryErrorDetail(envelope.error.data);
    throw new TrustRpcError(
      `${envelope.error.message}${detail === undefined ? "" : `: ${detail}`}`,
      envelope.error.code,
      envelope.error.data,
    );
  }
  return envelope.result;
}

function isRpcEnvelope(value: unknown, id: string): value is JsonRpcSuccess | JsonRpcFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || record.id !== id) return false;
  const hasResult = Object.hasOwn(record, "result");
  const hasError = Object.hasOwn(record, "error");
  if (hasResult === hasError) return false;
  if (hasResult) return true;
  const error = record.error;
  return typeof error === "object"
    && error !== null
    && !Array.isArray(error)
    && typeof (error as Record<string, unknown>).code === "number"
    && typeof (error as Record<string, unknown>).message === "string";
}

function rpcEndpoint(value: string): URL {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new TypeError(`Invalid TRUST_URL: ${value}`);
  }
  if ((base.protocol !== "http:" && base.protocol !== "https:")
    || base.username !== ""
    || base.password !== "") {
    throw new TypeError("TRUST_URL must be an HTTP(S) URL without embedded credentials");
  }
  base.pathname = "/rpc";
  base.search = "";
  base.hash = "";
  return base;
}

function registryErrorDetail(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}
