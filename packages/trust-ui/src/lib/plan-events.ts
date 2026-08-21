import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";

import { useRuntime } from "./runtime-context.js";

/* Live projection of the runtime: `GET /events/plans` (SSE). Every event only *invalidates* the queries it
   touches — the durable state is always re-read through RPC, exactly as the runtime intends (reconnecting
   clients resync). While the stream is down, the data hooks fall back to polling (`useLiveMode`). */

type PlanEventType = "plan.engaged" | "plan.revision" | "plan.removed" | "session.changed" | "runtime.changed";

interface PlanEvent {
  id: string;
  type: PlanEventType;
  at: string;
  plan?: string;
  resync?: true;
  revision?: number;
  cause?: "declarations" | "verdict";
}

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
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(runtime.planEventsUrl());
    let opened = false;
    const invalidateRuntime = () => { void queryClient.invalidateQueries(); };
    const invalidatePlan = (plan: string | undefined) => {
      void queryClient.invalidateQueries({ queryKey: ["plans"] });
      void queryClient.invalidateQueries({ queryKey: ["history"] });
      if (plan === undefined) {
        void queryClient.invalidateQueries({ queryKey: ["plan"] });
        void queryClient.invalidateQueries({ queryKey: ["check"] });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["plan", plan] });
      void queryClient.invalidateQueries({ queryKey: ["check"], predicate: (query) => String(query.queryKey[1] ?? "").includes(`/${plan}/`) });
    };
    const onEvent = (raw: MessageEvent<string>) => {
      let event: PlanEvent;
      try { event = JSON.parse(raw.data) as PlanEvent; } catch { return; }
      if (event.resync || event.type === "runtime.changed") invalidateRuntime();
      else invalidatePlan(event.plan);
    };
    const types: PlanEventType[] = ["plan.engaged", "plan.revision", "plan.removed", "session.changed", "runtime.changed"];
    for (const type of types) source.addEventListener(type, onEvent as EventListener);
    source.onopen = () => {
      setConnected(true);
      if (opened) invalidateRuntime();
      else invalidatePlan(undefined);
      opened = true;
    };
    source.onerror = () => setConnected(false);
    return () => { source.close(); setConnected(false); };
  }, [runtime, queryClient]);
}
