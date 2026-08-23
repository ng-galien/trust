import { request as requestHttp1, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import type { HttpMethod, JsonValue } from "@trust/operation";

export interface HttpRequest {
  readonly method: HttpMethod;
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
  const url = httpUrl(request.url);
  const maximum = request.maxResponseBytes ?? 10 * 1024 * 1024;
  const timeoutMs = request.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("HTTP maxResponseBytes must be a positive integer.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("HTTP timeoutMs must be a positive integer.");
  }
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      action();
    };
    const requestFunction = url.protocol === "https:" ? requestHttps : requestHttp1;
    if (request.method === "CONNECT" && (url.pathname !== "/" || url.search !== "")) {
      throw new TypeError("HTTP CONNECT URL must contain only the destination authority.");
    }
    const handle = requestFunction(url, {
      method: request.method,
      ...(request.method === "CONNECT" ? { path: url.host } : {}),
      ...(request.headers === undefined ? {} : { headers: request.headers }),
    });
    timeout = setTimeout(() => {
      handle.destroy(new Error("HTTP request timed out."));
    }, timeoutMs);
    handle.on("error", (error) => finish(() => reject(new Error(
      `requestHttp failed for ${request.method} ${url.origin}${url.pathname}.`,
      { cause: error },
    ))));
    handle.on("response", (response) => {
      void (responseHasMessageContent(request.method, response.statusCode ?? 0)
        ? responseBody(response, maximum)
        : emptyResponseBody(response))
        .then((body) => finish(() => resolve(httpResponse(response, body))))
        .catch((error: unknown) => finish(() => reject(error)));
    });
    // CONNECT upgrades the connection instead of emitting the regular response event. TRUST records
    // the handshake response and closes the tunnel because an Operation is one bounded request.
    handle.on("connect", (response: IncomingMessage, socket: Socket, head: Buffer) => {
      socket.destroy();
      if (head.byteLength > maximum) {
        finish(() => reject(new Error(`HTTP response exceeds ${maximum} bytes.`)));
        return;
      }
      finish(() => resolve(httpResponse(response, head.toString("utf8"))));
    });
    handle.on("upgrade", (response: IncomingMessage, socket: Socket, head: Buffer) => {
      socket.destroy();
      if (head.byteLength > maximum) {
        finish(() => reject(new Error(`HTTP response exceeds ${maximum} bytes.`)));
        return;
      }
      finish(() => resolve(httpResponse(response, head.toString("utf8"))));
    });
    if (request.body !== undefined) handle.write(request.body, "utf8");
    handle.end();
  });
}

async function emptyResponseBody(response: IncomingMessage): Promise<string> {
  for await (const _chunk of response) {
    // Drain without decoding: HEAD and no-content statuses may repeat representation metadata such
    // as Content-Encoding even though no encoded message content follows.
  }
  return "";
}

function responseHasMessageContent(method: HttpMethod, status: number): boolean {
  return method !== "HEAD"
    && (status < 100 || status >= 200)
    && status !== 204
    && status !== 205
    && status !== 304;
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

async function responseBody(response: IncomingMessage, maximum: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let stream: Readable = response;
  try {
    stream = decodedResponse(response);
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      size += chunk.byteLength;
      if (size > maximum) throw new Error(`HTTP response exceeds ${maximum} bytes.`);
      chunks.push(chunk);
    }
  } catch (error) {
    stream.destroy();
    response.destroy();
    throw error;
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function decodedResponse(response: IncomingMessage): Readable {
  const raw = response.headers["content-encoding"];
  const codings = (Array.isArray(raw) ? raw.join(",") : raw ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity")
    .reverse();
  let stream: Readable = response;
  for (const coding of codings) {
    if (coding === "gzip" || coding === "x-gzip") stream = stream.pipe(createGunzip());
    else if (coding === "deflate") stream = stream.pipe(createInflate());
    else if (coding === "br") stream = stream.pipe(createBrotliDecompress());
    else throw new TypeError(`HTTP response uses unsupported content encoding "${coding}".`);
  }
  return stream;
}

function httpResponse(response: IncomingMessage, body: string): HttpResponse {
  return {
    status: response.statusCode ?? 0,
    statusText: response.statusMessage ?? "",
    headers: normalizeHeaders(response.headers),
    body,
  };
}

function normalizeHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]
  ));
}

function loopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1"
    || hostname.endsWith(".127.0.0.1.nip.io")
    || hostname === "[::1]"
    || hostname === "::1";
}
