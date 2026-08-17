import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { TrustRuntimeClient } from "../runtime.js";
import type { HistoryFilter } from "../types.js";
import { useLiveMode } from "./plan-events.js";

export const RuntimeContext = createContext<TrustRuntimeClient | null>(null);

export function useRuntime(): TrustRuntimeClient {
  const client = useContext(RuntimeContext);
  if (!client) throw new Error("TRUST runtime client is unavailable");
  return client;
}

export function useHealth() {
  const runtime = useRuntime();
  return useQuery({ queryKey: ["health"], queryFn: runtime.health, refetchInterval: 5_000 });
}

export function useOperations() {
  const runtime = useRuntime();
  return useQuery({ queryKey: ["operations"], queryFn: runtime.operations });
}

export function useProcedures() {
  const runtime = useRuntime();
  return useQuery({ queryKey: ["procedures"], queryFn: runtime.procedures });
}

/** Polling cadence used only while the runtime event stream is down (see `plan-events.ts`). */
function useFallbackPolling(interval = 2_000): number | false {
  return useLiveMode() ? false : interval;
}

export function usePlans() {
  const runtime = useRuntime();
  return useQuery({ queryKey: ["plans"], queryFn: runtime.plans, refetchInterval: useFallbackPolling() });
}

export function usePlan(slug: string) {
  const runtime = useRuntime();
  return useQuery({ queryKey: ["plan", slug], queryFn: () => runtime.plan(slug), enabled: slug !== "", refetchInterval: useFallbackPolling(), retry: false });
}

export function useCheck(checkUri: string) {
  const runtime = useRuntime();
  return useQuery({ queryKey: ["check", checkUri], queryFn: () => runtime.check(checkUri), enabled: checkUri !== "", refetchInterval: useFallbackPolling() });
}

export function useEnvironments() {
  const runtime = useRuntime();
  return useQuery({ queryKey: ["environments"], queryFn: () => runtime.environments(), staleTime: 30_000 });
}

export function useCredentials(environment?: string) {
  const runtime = useRuntime();
  return useQuery({ queryKey: ["credentials", environment ?? ""], queryFn: () => runtime.credentials(environment), staleTime: 30_000 });
}

export function useOperationEnvironments() {
  const runtime = useRuntime();
  return useQuery({ queryKey: ["operation.environments"], queryFn: runtime.operationEnvironments, staleTime: 30_000 });
}

/** Verdict snapshots, newest first, one server page at a time (`history.list`); filters are applied by the runtime. */
export function useHistory(filter: HistoryFilter = {}, limit = 50) {
  const runtime = useRuntime();
  const polling = useFallbackPolling(5_000);
  const query = useInfiniteQuery({
    queryKey: ["history", filter, limit],
    queryFn: ({ pageParam }) => runtime.history({ filter, limit, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: polling,
  });
  return { ...query, rows: query.data?.pages.flatMap((page) => page.snapshots) ?? [] };
}
