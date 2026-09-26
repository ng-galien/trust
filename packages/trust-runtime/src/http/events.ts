import { randomUUID } from "node:crypto";
import type { PlanEvent } from "@trust/extension-sdk";
import express, { type Router } from "express";
import type { AccessService } from "../access/service.js";
import type { PlanEvents } from "../plan/events.js";
import type { PlanReader } from "../plan/read.js";
import { expireAccessStream, requestAccess } from "./access.js";

export interface PlanEventsHttpDependencies {
  readonly planEvents: PlanEvents;
  readonly planReader: PlanReader;
  readonly accessService: AccessService;
}

export function createPlanEventsHttpHandler({
  planEvents,
  planReader,
  accessService,
}: PlanEventsHttpDependencies): Router {
  const router = express.Router();
  router.get("/", (request, response) => {
    const context = requestAccess(request);
    try {
      accessService.authorize(context, "plan.read");
    } catch {
      response.status(403).json({ error: "access-denied" });
      return;
    }
    response.status(200).set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    expireAccessStream(context, response);
    response.write("retry: 3000\n\n");
    let sequence = 0;
    let closed = false;
    let pending = Promise.resolve();
    const send = (event: PlanEvent): void => {
      pending = pending
        .then(async () => {
          if (closed) return;
          const current = await accessService.authenticate(request.get("authorization"));
          accessService.authorize(current, "plan.read");
          if (event.type === "plan.removed") {
            if (!closed)
              response.write(
                `event: runtime.changed\ndata: ${JSON.stringify({ type: "runtime.changed", resync: true })}\n\n`,
              );
            return;
          }
          if (event.plan) {
            try {
              await planReader.readPlanBySlug(event.plan, false, current);
            } catch {
              return;
            }
          }
          if (closed) return;
          // Shared cursors contain no global sequence/count of other users' events.
          const visible = accessService.shared ? { ...event, sequence: ++sequence, id: randomUUID() } : event;
          response.write(`id: ${visible.id}\nevent: ${visible.type}\ndata: ${JSON.stringify(visible)}\n\n`);
        })
        .catch(() => {
          response.end();
        });
    };
    // Shared reconnect resyncs through filtered RPC instead of exposing a global replay cursor.
    const replay = accessService.shared
      ? { resync: true, events: [] }
      : planEvents.replay(eventId(request.get("last-event-id") ?? request.query.after));
    if (replay.resync) send(planEvents.resyncEvent(new Date().toISOString()));
    for (const event of replay.events) send(event);
    const unsubscribe = planEvents.subscribe(send);
    const heartbeat = setInterval(() => {
      void accessService
        .authenticate(request.get("authorization"))
        .then((current) => {
          accessService.authorize(current, "plan.read");
          if (!closed) response.write(": keep-alive\n\n");
        })
        .catch(() => {
          response.end();
        });
    }, 15_000);
    response.once("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  return router;
}
function eventId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= 256 ? value : "invalid";
}
