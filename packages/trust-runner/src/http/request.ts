import type { JsonValue } from "@trust/operation";

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export async function requestHttp(request: HttpRequest): Promise<HttpResponse> {
  const response = await fetch(httpUrl(request.url), {
    method: request.method,
    ...(request.headers === undefined ? {} : { headers: request.headers }),
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "error",
    signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body: await readResponse(response, request.maxResponseBytes ?? 10 * 1024 * 1024),
  };
}

export function parseHttpJson(body: string): JsonValue {
  try {
    return JSON.parse(body) as JsonValue;
  } catch (error) {
    throw new Error("HTTP response is not valid JSON.", { cause: error });
  }
}

export function httpUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new TypeError("HTTP URL must be absolute.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new TypeError("HTTP URL must use HTTP(S) without embedded credentials.");
  }
  if (url.protocol === "http:" && !loopback(url.hostname)) {
    throw new TypeError("HTTP URL must use HTTPS outside loopback.");
  }
  return url;
}

async function readResponse(response: Response, maximum: number): Promise<string> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("HTTP maxResponseBytes must be a positive integer.");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error(`HTTP response exceeds ${maximum} bytes.`);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function loopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1"
    || hostname.endsWith(".127.0.0.1.nip.io")
    || hostname === "[::1]"
    || hostname === "::1";
}
