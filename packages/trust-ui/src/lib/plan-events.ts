import { useQueryClient } from "@tanstack/react-query";
import type { PlanEvent, PlanEventType } from "@trust/extension-sdk";
import { useEffect } from "react";
import { create } from "zustand";
import { AuthenticatedEventSource } from "./authenticated-events.js";

import { useRuntime } from "./runtime-context.js";

/* Live projection of the runtime: `GET /events/plans` (SSE). Every event only *invalidates* the queries it
   touches — the durable state is always re-read through RPC, exactly as the runtime intends (reconnecting
   clients resync). While the stream is down, the data hooks fall back to polling (`useLiveMode`). */

/** Client-side runtime state (not persisted): is the event stream connected? */
const useRuntimeStateStore = create<{ live: boolean }>(() => ({ live: false }));
const setConnected = (live: boolean) => useRuntimeStateStore.setState({ live });

/** True while the event stream is connected; data hooks poll only when it is not. */
export function useLiveMode(): boolean {
  return useRuntimeStateStore((state) => state.live);
}

/** Mount once: subscribes to the runtime event stream and invalidates the affected queries. */
export function usePlanEventsBridge(): void {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new AuthenticatedEventSource(runtime.planEventsUrl());
    let opened = false;
    const invalidateRuntime = () => {
      void queryClient.invalidateQueries();
    };
    // Events arrive in bursts: one flush per burst reads each list once, however many events it holds.
    const pending = new Set<string>();
    let every = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      void queryClient.invalidateQueries({ queryKey: ["plans"] });
      void queryClient.invalidateQueries({ queryKey: ["history"] });
      if (every) {
        void queryClient.invalidateQueries({ queryKey: ["plan"] });
        void queryClient.invalidateQueries({ queryKey: ["check"] });
      } else {
        for (const plan of pending) {
          void queryClient.invalidateQueries({ queryKey: ["plan", plan] });
          void queryClient.invalidateQueries({
            queryKey: ["check"],
            predicate: (query) => String(query.queryKey[1] ?? "").includes(`/${plan}/`),
          });
        }
      }
      pending.clear();
      every = false;
    };
    const invalidatePlan = (plan: string | undefined) => {
      if (plan === undefined) every = true;
      else pending.add(plan);
      timer ??= setTimeout(flush, 150);
    };
    const onEvent = (raw: MessageEvent<string>) => {
      let event: PlanEvent;
      try {
        event = JSON.parse(raw.data) as PlanEvent;
      } catch {
        return;
      }
      if (event.resync || event.type === "runtime.changed") invalidateRuntime();
      else invalidatePlan(event.plan);
    };
    const types: PlanEventType[] = [
      "plan.engaged",
      "plan.revision",
      "plan.state",
      "plan.removed",
      "session.changed",
      "runtime.changed",
    ];
    for (const type of types) source.addEventListener(type, onEvent as EventListener);
    source.onopen = () => {
      setConnected(true);
      if (opened) invalidateRuntime();
      else invalidatePlan(undefined);
      opened = true;
    };
    source.onerror = () => setConnected(false);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      source.close();
      setConnected(false);
    };
  }, [runtime, queryClient]);
}
