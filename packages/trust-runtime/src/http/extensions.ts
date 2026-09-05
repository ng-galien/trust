import express, { type Response, Router } from "express";
import { ExtensionError, type ExtensionHost } from "../extensions/host.js";
import { confinedPath } from "../extensions/manifest.js";
import type { PlanEvents } from "../plan/events.js";
import type { PlanReader } from "../plan/read.js";

export function createExtensionsHttpHandler({
  extensionHost,
  planReader,
  planEvents,
}: {
  extensionHost: ExtensionHost;
  planReader: PlanReader;
  planEvents: PlanEvents;
}): Router {
  const router = Router();
  router.use(express.json({ limit: "64kb" }));
  router.use((request, response) => {
    const run = async () => {
      if (request.path === "/" && request.method === "GET") {
        response.json({ extensions: extensionHost.list().map((value) => value.descriptor()) });
        return;
      }
      const [id = "", surface, ...rest] = request.path.slice(1).split("/");
      const extension = extensionHost.get(id);
      if (["prepare", "start", "stop"].includes(surface ?? "") && rest.length === 0 && request.method === "POST") {
        if (!request.body || Array.isArray(request.body) || Object.keys(request.body).length)
          throw new ExtensionError(400, "invalid-extension-request");
        response.json({ extension: await extension.transition(surface as "prepare" | "start" | "stop") });
        return;
      }
      if (surface === "commands" && rest.length === 0 && request.method === "POST") {
        const result = await extension.command(request.body);
        response.status(result.status).json(result.body);
        return;
      }
      if (request.method !== "GET") throw new ExtensionError(405, "extension-read-only");
      extension.requireRunning();
      if (surface === "api") {
        const query: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.query)) {
          if (typeof value !== "string") throw new ExtensionError(400, "invalid-extension-query");
          query[key] = value;
        }
        const result = await extension.read({ path: "/" + rest.join("/"), query });
        if (
          !result ||
          !Number.isInteger(result.status) ||
          result.status < 200 ||
          result.status > 599 ||
          result.body === undefined
        )
          throw new ExtensionError(502, "invalid-extension-response");
        if (result.status >= 400) throw new ExtensionError(result.status, "extension-read-failed");
        response.status(result.status).json(result.body);
        return;
      }
      if (surface === "assets" && extension.installation.ui) {
        try {
          const file = await confinedPath(extension.installation.ui.assets, decodeURIComponent(rest.join("/")));
          response.sendFile(file, (error) => {
            if (error && !response.headersSent) response.status(404).end();
          });
        } catch {
          throw new ExtensionError(404, "extension-asset-not-found");
        }
        return;
      }
      if (surface === "trust" && rest[0] === "plans") {
        extension.requireGrant("plans.read");
        if (rest.length === 1) {
          const plans = [];
          let cursor: string | undefined;
          do {
            const page = await planReader.listPlans(cursor === undefined ? {} : { cursor });
            plans.push(...page.plans.filter((plan) => plan.environment === extension.installation.environment));
            cursor = page.nextCursor;
          } while (cursor !== undefined);
          response.json({ plans });
          return;
        }
        if (rest.length === 2) {
          try {
            const plan = await planReader.readPlanBySlug(decodeURIComponent(rest[1]!));
            if (plan.environment !== extension.installation.environment) throw new Error();
            response.json(plan);
          } catch {
            throw new ExtensionError(404, "plan-not-found");
          }
          return;
        }
      }
      if (surface === "events" && rest.length === 0) {
        extension.requireGrant("plans.read");
        extension.requireGrant("plans.subscribe");
        response
          .status(200)
          .set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        response.flushHeaders();
        let closed = false;
        const send = (value: unknown) => {
          if (!closed) response.write(`event: change\ndata: ${JSON.stringify(value)}\n\n`);
        };
        send({ type: "resync" });
        const unsubscribe = planEvents.subscribe((event) => {
          if (!event.plan) {
            send({ type: "resync" });
            return;
          }
          void planReader
            .readPlanBySlug(event.plan)
            .then((plan) => {
              if (plan.environment === extension.installation.environment)
                send({ type: "plan.changed", plan: event.plan });
            })
            .catch(() => send({ type: "resync" }));
        });
        const changed = () => send({ type: "extension.changed" });
        const stop = () => {
          cleanup();
          response.end();
        };
        const cleanup = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          extension.events.off("changed", changed);
          extension.events.off("stopped", stop);
        };
        extension.events.on("changed", changed);
        extension.events.on("stopped", stop);
        response.once("close", cleanup);
        return;
      }
      throw new ExtensionError(404, "extension-route-not-found");
    };
    void run().catch((error) => sendError(response, error));
  });
  router.use((error: unknown, _request: express.Request, response: Response, _next: express.NextFunction) =>
    sendError(response, error),
  );
  return router;
}

function sendError(response: Response, error: unknown) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const known = error instanceof ExtensionError;
  response.status(known ? error.status : 400).json({
    error: {
      code: known ? error.code : "invalid-extension-request",
      message: "Extension request could not be completed.",
    },
  });
}
