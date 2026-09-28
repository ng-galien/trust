import type { Request, Router } from "express";
import express from "express";
import type { DevelopmentAuthority } from "../access/development-authority.js";
import { AccessError } from "../access/error.js";

const COOKIE = "trust_dev_session";
const SESSION_AGE_MS = 8 * 60 * 60 * 1000;

const loopback = (address: string | undefined): boolean =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

function localOrigin(request: Request): boolean {
  const origin = request.get("origin");
  if (!origin || !loopback(request.socket.remoteAddress)) return false;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) &&
      parsed.host === request.get("host")
    );
  } catch {
    return false;
  }
}

function cookie(request: Request): string | undefined {
  const entry = request
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  return entry?.slice(COOKIE.length + 1);
}

export function createDevelopmentAuthenticationHttpHandler(authority: DevelopmentAuthority): Router {
  const router = express.Router();
  router.post("/service-token", express.json({ limit: "1kb", strict: true }), (request, response) => {
    response.setHeader("cache-control", "no-store");
    let localHost = false;
    try {
      localHost = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(`http://${request.get("host")}`).hostname);
    } catch {
      /* Invalid Host is refused below. */
    }
    if (!loopback(request.socket.remoteAddress) || !localHost || request.get("origin")) {
      response.status(403).json({ error: "untrusted-origin" });
      return;
    }
    const input =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    if (typeof input.clientId !== "string" || typeof input.secret !== "string") {
      response.status(400).json({ error: "invalid-service-credential" });
      return;
    }
    void authority
      .issueForService(input.clientId, input.secret)
      .then((token) => response.status(200).json({ accessToken: token, expiresIn: 120 }))
      .catch((error) =>
        response.status(error instanceof AccessError ? error.status : 503).json({
          error: error instanceof AccessError ? error.code : "authority-unavailable",
        }),
      );
  });
  router.post("/token", express.json({ limit: "1kb", strict: true }), (request, response) => {
    response.setHeader("cache-control", "no-store");
    const origin = request.get("origin");
    const host = request.get("host");
    const remote = origin === authority.tailnetOrigin && host === new URL(authority.tailnetOrigin).host;
    const local = localOrigin(request);
    if (!remote && !local) {
      response.status(403).json({ error: "untrusted-origin" });
      return;
    }
    const requestedCode =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>).code
        : undefined;
    if (requestedCode !== undefined && (typeof requestedCode !== "string" || requestedCode.length > 128)) {
      response.status(400).json({ error: "invalid-code" });
      return;
    }
    void Promise.resolve()
      .then(async () => {
        if (remote) {
          const login = request.get("tailscale-user-login");
          if (!login || !/^[a-zA-Z0-9._+@-]+$/.test(login))
            throw new AccessError("unauthenticated", "Tailnet identity is required");
          return authority.issueForTailnet(login);
        }
        if (typeof requestedCode === "string") return authority.issueForLocalCode(requestedCode);
        const session = cookie(request);
        if (!session) throw new AccessError("unauthenticated", "Local development code is required");
        return authority.issueForLocalSession(session);
      })
      .then((issued) => {
        const token = typeof issued === "string" ? issued : issued.token;
        if (typeof issued !== "string") {
          response.cookie(COOKIE, issued.session, {
            httpOnly: true,
            secure: false,
            sameSite: "strict",
            path: "/auth/dev",
            maxAge: SESSION_AGE_MS,
          });
        }
        response.status(200).json({ accessToken: token, expiresIn: 120 });
      })
      .catch((error) =>
        response.status(error instanceof AccessError ? error.status : 503).json({
          error: error instanceof AccessError ? error.code : "authority-unavailable",
        }),
      );
  });
  router.post("/logout", (request, response) => {
    if (!localOrigin(request)) {
      response.status(403).json({ error: "untrusted-origin" });
      return;
    }
    const session = cookie(request);
    void (session ? authority.revokeLocalSession(session) : Promise.resolve()).finally(() => {
      response.clearCookie(COOKIE, { httpOnly: true, sameSite: "strict", path: "/auth/dev" });
      response.setHeader("cache-control", "no-store");
      response.status(204).end();
    });
  });
  return router;
}
