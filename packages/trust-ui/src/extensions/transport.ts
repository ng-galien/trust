import type { ExtensionEventStream, ExtensionPageProps } from "@trust/extension-sdk";
import { AuthenticatedEventSource } from "../lib/authenticated-events.js";
import type { BrowserAuthentication } from "../lib/authentication.js";

/** One subscriber of an extension's shared event stream: the same contract as a stream of its own. */
class EventSubscription extends EventTarget implements ExtensionEventStream {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(private readonly release: (subscription: EventSubscription) => void) {
    super();
  }
  close(): void {
    this.readyState = 2;
    this.release(this);
  }
}

/** The extension's single connection: every event it receives is delivered to each current subscriber. */
class SharedEventSource extends AuthenticatedEventSource {
  readonly subscribers = new Set<EventSubscription>();
  override dispatchEvent(event: Event): boolean {
    const message = event as MessageEvent;
    for (const subscriber of this.subscribers)
      subscriber.dispatchEvent(new MessageEvent(event.type, { data: message.data, lastEventId: message.lastEventId }));
    return super.dispatchEvent(event);
  }
}

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
  // Browsers keep a handful of connections per server: every view of the extension shares one event stream,
  // so long-lived subscriptions never starve its requests.
  let shared: SharedEventSource | undefined;
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
        if (!shared) {
          const source = new SharedEventSource(`${origin}${prefix}events`, (input, init) => send(input, init, true));
          source.onopen = (event) => {
            for (const subscriber of source.subscribers) {
              subscriber.readyState = 1;
              subscriber.onopen?.(event);
            }
          };
          source.onerror = (event) => {
            for (const subscriber of source.subscribers) {
              subscriber.readyState = 0;
              subscriber.onerror?.(event);
            }
          };
          shared = source;
        }
        const source = shared;
        const subscription = new EventSubscription((closed) => {
          source.subscribers.delete(closed);
          if (source.subscribers.size === 0 && shared === source) {
            source.close();
            shared = undefined;
          }
        });
        source.subscribers.add(subscription);
        // A late subscriber of an open stream still learns that it is connected.
        if (source.readyState === 1)
          setTimeout(() => {
            if (subscription.readyState !== 0 || !source.subscribers.has(subscription)) return;
            subscription.readyState = 1;
            subscription.onopen?.(new Event("open"));
          }, 0);
        return subscription;
      },
    },
    dispose() {
      controller.abort();
      shared?.close();
      shared = undefined;
    },
  };
}
