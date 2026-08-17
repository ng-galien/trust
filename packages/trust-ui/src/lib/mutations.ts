import { useMutation, useQueryClient } from "@tanstack/react-query";

import { RuntimeError } from "../runtime.js";
import type { JsonObject, PlanMode } from "../types.js";
import { useRuntime } from "./runtime-context.js";

/* Write hooks — every mutation the interface performs on the runtime, with the query invalidations that
   follow. Overlays, homes and the sidebar menus compose these; none of them re-declares a mutation. */

/** Human-readable failure of a mutation (the runtime detail when there is one). */
export function mutationError(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof RuntimeError ? error.detail : error instanceof Error ? error.message : String(error);
}

/** Technical payload of a runtime failure (method, code, data) for the "Technical details" disclosure. */
export function mutationErrorDetails(error: unknown): string | undefined {
  return error instanceof RuntimeError ? error.technical : undefined;
}

export function usePublishProcedure() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source: string) => runtime.publishProcedure(source),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["procedures"] }),
  });
}

export function useSaveOperation() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, sourceName }: { source: string; sourceName: string }) => runtime.saveOperation(source, sourceName),
    onSuccess: () => invalidateCatalog(queryClient),
  });
}

export function useRemoveOperation() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ operation, version }: { operation: string; version: string }) => runtime.removeOperation(operation, version),
    onSuccess: () => invalidateCatalog(queryClient),
  });
}

/** Dry-runs only: erase the Plan (Delete), or erase and engage it again as it was (Reset). */
export function useRemovePlan() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ plan, again }: { plan: string; again?: { procedure: string; procedureVersion: string; environment: string; rootInputs: JsonObject; mode: PlanMode } }) => {
      await runtime.removePlan(plan);
      if (again) await runtime.engagePlan({ ...again, plan });
    },
    onSuccess: (_result, { plan }) => invalidatePlan(queryClient, plan),
  });
}

/** Live Plans: close the open Session — the agent can no longer admit attempts until a new Session opens. */
export function useClosePlan() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plan: string) => runtime.closePlan(plan),
    onSuccess: (_result, plan) => invalidatePlan(queryClient, plan),
  });
}

export function useSaveEnvironment() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ environment, values }: { environment: string; values: Record<string, string> }) => runtime.saveEnvironment(environment, values),
    onSuccess: () => invalidateEnvironments(queryClient),
  });
}

export function useRemoveEnvironment() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (environment: string) => runtime.removeEnvironment(environment),
    onSuccess: () => invalidateEnvironments(queryClient),
  });
}

/** Credentials: the value is written once and never read back — the interface only ever lists references. */
export function useSaveCredential() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ environment, name, value }: { environment: string; name: string; value: string }) => runtime.saveCredential(environment, name, value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["credentials"] }),
  });
}

export function useRemoveCredential() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ environment, name }: { environment: string; name: string }) => runtime.removeCredential(environment, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["credentials"] }),
  });
}

type Client = ReturnType<typeof useQueryClient>;
const invalidateCatalog = (client: Client) => Promise.all([client.invalidateQueries({ queryKey: ["operations"] }), client.invalidateQueries({ queryKey: ["operation.environments"] }), client.invalidateQueries({ queryKey: ["environments"] })]);
const invalidateEnvironments = (client: Client) => Promise.all([client.invalidateQueries({ queryKey: ["environments"] }), client.invalidateQueries({ queryKey: ["operation.environments"] }), client.invalidateQueries({ queryKey: ["credentials"] })]);
const invalidatePlan = (client: Client, plan: string) => Promise.all([client.invalidateQueries({ queryKey: ["plans"] }), client.invalidateQueries({ queryKey: ["plan", plan] }), client.invalidateQueries({ queryKey: ["history"] })]);
