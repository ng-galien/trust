import express, { type Router } from "express";

import type { PlanEvent, PlanEvents } from "../plan/events.js";

export interface PlanEventsHttpDependencies {
  readonly planEvents: PlanEvents;
}

export function createPlanEventsHttpHandler({ planEvents }: PlanEventsHttpDependencies): Router {
  const router = express.Router();
  router.get("/", (request, response) => {
    const lastEventId = eventId(request.get("last-event-id") ?? request.query.after);
    response.status(200);
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    // First bytes right away: proxies hold the response until the body starts, and clients reconnect after 3 s.
    response.write("retry: 3000\n\n");

    const send = (event: PlanEvent): void => {
      response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const replay = planEvents.replay(lastEventId);
    if (replay.resync) send(planEvents.resyncEvent(new Date().toISOString()));
    for (const event of replay.events) send(event);
    const unsubscribe = planEvents.subscribe(send);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    request.on("close", () => {
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
