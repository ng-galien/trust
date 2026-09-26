import type { DelegationEpisodeView } from "@trust/extension-sdk";
import { useCallback, useEffect, useState } from "react";
import { useMobileTransport } from "./transport";

function isEpisode(value: unknown, plan: string): value is DelegationEpisodeView {
  if (!value || typeof value !== "object") return false;
  const episode = value as Partial<DelegationEpisodeView>;
  return (
    episode.contract === "trust.delegation-episode@1" &&
    episode.root?.plan?.plan === plan &&
    Array.isArray(episode.root.checks) &&
    Array.isArray(episode.branches)
  );
}

export function useDelegationEpisode(trustBase: string, eventsUrl: string, plan: string | null) {
  const transport = useMobileTransport();
  const [episode, setEpisode] = useState<DelegationEpisodeView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(plan));

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!plan) return;
      try {
        const response = await transport.fetch(
          `${trustBase}/episodes/${encodeURIComponent(plan)}`,
          signal ? { signal } : {},
        );
        if (!response.ok) throw new Error(`Episode unavailable (${response.status})`, { cause: response.status });
        const body: unknown = await response.json();
        if (!isEpisode(body, plan)) throw new Error("Invalid episode response");
        if (signal?.aborted) return;
        setEpisode(body);
        setError("");
      } catch (cause) {
        if (signal?.aborted) return;
        if (cause instanceof Error && (cause.cause === 401 || cause.cause === 403 || cause.cause === 404))
          setEpisode(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [transport, plan, trustBase],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed public stream URL must reopen the subscription even if the transport object is reused.
  useEffect(() => {
    setEpisode(null);
    setError("");
    setLoading(Boolean(plan));
    if (!plan) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const events = transport.openEvents();
    const changed = () => void refresh(controller.signal);
    const visible = () => {
      if (document.visibilityState === "visible") changed();
    };
    events.addEventListener("change", changed);
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      events.close();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [transport, eventsUrl, plan, refresh]);

  return { episode, error, loading, refresh };
}
