import type { AccessContext } from "@trust/extension-sdk";
import { matchAccessContext } from "@trust/extension-sdk/match";
import type { Request, RequestHandler, Response } from "express";
import { AccessError } from "../access/error.js";
import type { AccessService } from "../access/service.js";

const contexts = new WeakMap<Request, AccessContext>();

/** Context is created from the transport credential, never from request JSON. */
export function authenticateHttp(accessService: AccessService): RequestHandler {
  return (request, response, next) => {
    if (request.query.access_token !== undefined) {
      response.status(400).json({ error: "token-in-url-refused" });
      return;
    }
    void accessService
      .authenticate(request.get("authorization"))
      .then((context) => {
        contexts.set(request, context);
        next();
      })
      .catch((error) => {
        response.setHeader("www-authenticate", 'Bearer realm="trust"');
        response
          .status(error instanceof AccessError ? error.status : 503)
          .json({ error: error instanceof AccessError ? error.code : "authority-unavailable" });
      });
  };
}

export function requestAccess(request: Request): AccessContext | undefined {
  return contexts.get(request);
}

/** A streaming response never outlives its credential; reconnect authenticates anew. */
export function expireAccessStream(context: AccessContext | undefined, response: Response): void {
  if (context === undefined) return;
  const expiresAt = matchAccessContext(context, {
    local: () => undefined,
    authenticated: (value) => value.expiresAt,
  });
  if (expiresAt === undefined || expiresAt === null) return;
  const timer = setTimeout(() => response.end(), Math.max(0, expiresAt * 1000 - Date.now()));
  timer.unref();
  response.once("close", () => clearTimeout(timer));
}

/** Revalidate online decisions for idle streams; close on withdrawal or authority outage. */
export function guardAccessStream(
  service: AccessService,
  request: Request,
  response: Response,
  actions: readonly string[] | ((context: AccessContext) => void) = [],
): void {
  const heartbeat = setInterval(() => {
    void service
      .authenticate(request.get("authorization"))
      .then((context) => {
        if (typeof actions === "function") actions(context);
        else for (const action of actions) service.authorize(context, action);
      })
      .catch(() => response.end());
  }, 15_000);
  heartbeat.unref();
  response.once("close", () => clearInterval(heartbeat));
}
