import express, { type Response, Router } from "express";
import { AccessError } from "../access/error.js";
import type { AccessService } from "../access/service.js";
import {
  ExtensionError,
  type ExtensionHost,
  ExtensionSettingsRejected,
  parseExtensionSettingsUpdate,
} from "../extensions/host.js";
import type { PlanEvents } from "../plan/events.js";
import { type PlanReader, ReadError } from "../plan/read.js";
import { type PlanRuntime, PlanRuntimeError } from "../plan/runtime.js";
import { expireAccessStream, guardAccessStream, requestAccess } from "./access.js";
import { InvalidPlanRuntimeRpcParams, parsePlanDeclarationReplacement } from "./plan.js";

export function createExtensionsHttpHandler({
  extensionHost,
  accessService,
  planReader,
  planEvents,
  planRuntime,
}: {
  extensionHost: ExtensionHost;
  accessService: AccessService;
  planReader: PlanReader;
  planEvents: PlanEvents;
  planRuntime: PlanRuntime;
}): Router {
  const router = Router();
  router.use(express.json({ limit: "64kb" }));
  router.use((request, response) => {
    const run = async () => {
      const access = requestAccess(request);
      if (request.path === "/" && request.method === "GET") {
        accessService.authorize(access, "extension.list");
        response.json({ extensions: extensionHost.list().map((value) => value.descriptor()) });
        return;
      }
      const [id = "", surface, ...rest] = request.path.slice(1).split("/");
      const extension = extensionHost.get(id);
      if (["prepare", "start", "stop"].includes(surface ?? "") && rest.length === 0 && request.method === "POST") {
        if (!request.body || Array.isArray(request.body) || Object.keys(request.body).length)
          throw new ExtensionError(400, "invalid-extension-request");
        accessService.authorize(access, `extension.${surface}`);
        response.json({ extension: await extension.transition(surface as "prepare" | "start" | "stop") });
        return;
      }
      if (surface === "settings" && rest.length === 0 && request.method === "GET") {
        accessService.authorize(access, "extension.settings.read");
        response.json({ settings: await extensionHost.readSettings(id) });
        return;
      }
      if (surface === "settings" && rest.length === 0 && request.method === "PUT") {
        accessService.authorize(access, "extension.settings.update");
        response.json(await extensionHost.updateSettings(parseExtensionSettingsUpdate(id, request.body)));
        return;
      }
      if (surface === "commands" && rest.length === 0 && request.method === "POST") {
        const result = await extension.command(request.body, access);
        response.status(result.status).json(result.body);
        return;
      }
      if (
        surface === "trust" &&
        rest[0] === "plans" &&
        rest.length === 3 &&
        rest[2] === "declarations" &&
        request.method === "POST"
      ) {
        accessService.authorizeExtension(access, id);
        extension.requireRunning();
        extension.requireGrant("plans.declare");
        const input = parsePlanDeclarationReplacement(request.body);
        if (input.plan !== decodeURIComponent(rest[1] ?? ""))
          throw new ExtensionError(400, "invalid-extension-request");
        const plan = await planReader.readLivePlanBySlug(input.plan, access);
        if (plan.environment !== extension.installation.environment) throw new ExtensionError(404, "plan-not-found");
        response.json(await planRuntime.replaceDeclarations(input, access));
        return;
      }
      if (request.method !== "GET") throw new ExtensionError(405, "extension-read-only");
      if (surface === "trust" || surface === "events") accessService.authorizeExtension(access, id);
      else if (surface !== "api") accessService.authorize(access, "extension.status");
      extension.requireRunning();
      if (surface === "api") {
        const query: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.query)) {
          if (typeof value !== "string") throw new ExtensionError(400, "invalid-extension-query");
          query[key] = value;
        }
        const result = await extension.read({ path: `/${rest.join("/")}`, query }, access);
        if (result.status >= 400) throw new ExtensionError(result.status, "extension-read-failed");
        response.status(result.status).json(result.body);
        return;
      }
      if (surface === "trust" && rest[0] === "plans") {
        extension.requireGrant("plans.read");
        if (rest.length === 1) {
          const plans = [];
          let cursor: string | undefined;
          do {
            const page = await planReader.listPlans(cursor === undefined ? {} : { cursor }, access);
            plans.push(...page.plans.filter((plan) => plan.environment === extension.installation.environment));
            cursor = page.nextCursor;
          } while (cursor !== undefined);
          response.json({ plans });
          return;
        }
        if (rest.length === 2) {
          try {
            // Extensions follow current progress: the revision history and sessions stay on the Plan read.
            const plan = await planReader.readLivePlanBySlug(decodeURIComponent(rest[1] ?? ""), access);
            if (plan.environment !== extension.installation.environment) throw new Error();
            response.json(plan);
          } catch {
            throw new ExtensionError(404, "plan-not-found");
          }
          return;
        }
      }
      if (surface === "trust" && rest[0] === "episodes" && rest.length === 2) {
        extension.requireGrant("plans.read");
        try {
          const episode = await planReader.readDelegationEpisode(decodeURIComponent(rest[1] ?? ""), access);
          if (episode.root.plan.environment !== extension.installation.environment) throw new Error();
          if (
            episode.branches.some(({ child }) => child && child.plan.environment !== extension.installation.environment)
          )
            throw new Error();
          response.json(episode);
        } catch {
          throw new ExtensionError(404, "plan-not-found");
        }
        return;
      }
      if (surface === "events" && rest.length === 0) {
        response
          .status(200)
          .set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        response.flushHeaders();
        expireAccessStream(access, response);
        guardAccessStream(accessService, request, response, [`extension.${id}.use`]);
        let closed = false;
        const send = (value: unknown, planSlug?: string) => {
          void accessService
            .authenticate(request.get("authorization"))
            .then(async (current) => {
              accessService.authorizeExtension(current, id);
              if (planSlug) await planReader.readLivePlanBySlug(planSlug, current);
              if (!closed) response.write(`event: change\ndata: ${JSON.stringify(value)}\n\n`);
            })
            .catch(() => response.end());
        };
        send({ type: "resync" });
        const unsubscribe = planEvents.subscribe((event) => {
          if (
            !extension.installation.grants.includes("plans.read") ||
            !extension.installation.grants.includes("plans.subscribe")
          )
            return;
          if (!event.plan || event.type === "plan.removed") {
            send({ type: "resync" });
            return;
          }
          const changed = event.plan;
          void accessService
            .authenticate(request.get("authorization"))
            .then((current) => {
              accessService.authorizeExtension(current, id);
              return planReader.readLivePlanBySlug(changed, current);
            })
            .then((plan) => {
              if (plan.environment === extension.installation.environment)
                send({ type: "plan.changed", plan: changed }, changed);
            })
            .catch(() => undefined);
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
  if (error instanceof AccessError) {
    response.status(error.status).json({ error: { code: error.code, message: "Access denied" } });
    return;
  }
  if (error instanceof InvalidPlanRuntimeRpcParams) {
    response.status(400).json({ error: { code: "invalid-extension-request", message: error.message } });
    return;
  }
  if (error instanceof PlanRuntimeError) {
    response
      .status(error.code === "plan-conflict" ? 409 : 400)
      .json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ReadError) {
    response.status(404).json({ error: { code: error.code, message: "Plan unavailable" } });
    return;
  }
  const known = error instanceof ExtensionError;
  response.status(known ? error.status : 400).json({
    error: {
      code: known ? error.code : "invalid-extension-request",
      message: known ? error.message : "Extension request could not be completed.",
      ...(error instanceof ExtensionSettingsRejected ? { issues: error.issues } : {}),
    },
  });
}
