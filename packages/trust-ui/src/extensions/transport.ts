import type { ExtensionPageProps } from "@trust/extension-sdk";
import { AuthenticatedEventSource } from "../lib/authenticated-events.js";
import type { BrowserAuthentication } from "../lib/authentication.js";

/** One installed extension gets a bounded transport, not the host's credential. */
export function createExtensionTransport(
  baseUrl: string,
  extensionId: string,
  authentication: Pick<BrowserAuthentication, "token" | "requireLogin">,
  request: typeof fetch = fetch,
): { transport: ExtensionPageProps["transport"]; dispose(): void } {
  if (!/^[a-z][a-z0-9-]*$/u.test(extensionId)) throw new Error("Invalid extension identity");
  const origin = new URL(baseUrl || window.location.origin, window.location.origin).origin;
  const prefix = `/extensions/${extensionId}/`;
  const controller = new AbortController();
  const streams = new Set<AuthenticatedEventSource>();
  const resolve = (input: string, events: boolean): URL => {
    if (input.includes("\\")) throw new Error("Extension request is outside its transport");
    const rawPath = input.split(/[?#]/u)[0] ?? "";
    if (
      rawPath
        .split("/")
        .map((part) => decodeURIComponent(part))
        .some((part) => part === "." || part === ".." || part.includes("\\"))
    )
      throw new Error("Extension request is outside its transport");
    const url = new URL(input, origin);
    const pieces = url.pathname.split("/").map((part) => decodeURIComponent(part));
    if (
      pieces.some((part) => part === "." || part === ".." || part.includes("/") || part.includes("\\")) ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith(prefix)
    )
      throw new Error("Extension request is outside its transport");
    const surface = url.pathname.slice(prefix.length);
    if (
      events
        ? surface !== "events" || !!url.search
        : !(surface === "commands" || surface.startsWith("api/") || surface.startsWith("trust/"))
    )
      throw new Error("Extension request is outside its transport");
    if ([...url.searchParams.keys()].some((key) => /^(?:access_token|refresh_token|authorization|token)$/iu.test(key)))
      throw new Error("Credentials cannot be URL parameters");
    return url;
  };
  const send = async (input: string, init: RequestInit = {}, events = false): Promise<Response> => {
    const url = resolve(input, events);
    controller.signal.throwIfAborted();
    const headers = new Headers(init.headers);
    if (headers.has("authorization") || headers.has("cookie") || init.credentials === "include")
      throw new Error("Extension credentials are owned by the host");
    const token = await authentication.token();
    controller.signal.throwIfAborted();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await request(url, {
      ...init,
      headers,
      credentials: "omit",
      redirect: "error",
      signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
    });
    if (response.status === 401) await authentication.requireLogin();
    return response;
  };
  return {
    transport: {
      fetch: (input, init) => send(input, init),
      openEvents() {
        controller.signal.throwIfAborted();
        const stream = new AuthenticatedEventSource(`${origin}${prefix}events`, (input, init) =>
          send(input, init, true),
        );
        streams.add(stream);
        const close = stream.close.bind(stream);
        stream.close = () => {
          streams.delete(stream);
          close();
        };
        return stream;
      },
    },
    dispose() {
      controller.abort();
      for (const stream of streams) stream.close();
      streams.clear();
    },
  };
}
