import { useCallback, useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";

import { EPHEMERAL_PARAMS } from "./overlay-state.js";

/* URL-backed filter state, remembered per resource in the browser:
   arriving without parameters restores the last used view, sort, group and filters.
   Overlay-only keys (tab, selection, duplication source) are never remembered. */

const storageKey = (key: string) => `trust.ui.filters.${key}`;

export function useUrlFilters<F>(
  read: (params: URLSearchParams) => F,
  write: (filters: F, base: URLSearchParams) => URLSearchParams,
  persistKey?: string,
): [F, (patch: Partial<F>) => void] {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const latest = useRef(params);
  latest.current = params;
  const restored = useRef(false);

  // First visit without parameters: bring back what the browser remembers for this resource.
  useEffect(() => {
    if (!persistKey || restored.current) return;
    restored.current = true;
    // Overlay-only keys (an item's tab/selection) do not count as "having filters".
    const incoming = new URLSearchParams(location.search);
    const filtersOnly = new URLSearchParams(incoming);
    for (const key of EPHEMERAL_PARAMS) filtersOnly.delete(key);
    if (filtersOnly.toString() !== "") return;
    try {
      const stored = localStorage.getItem(storageKey(persistKey));
      if (stored) {
        const next = new URLSearchParams(stored);
        for (const key of EPHEMERAL_PARAMS) {
          const value = incoming.get(key);
          if (value !== null) next.set(key, value);
        }
        latest.current = next;
        setParams(next, { replace: true, state: location.state });
      }
    } catch {
      // storage unavailable
    }
  }, [persistKey, location.search, location.state, setParams]);

  // Every state the user reaches is remembered, including "no filter".
  useEffect(() => {
    if (!persistKey || !restored.current) return;
    try {
      const remembered = new URLSearchParams(params);
      for (const key of EPHEMERAL_PARAMS) remembered.delete(key);
      localStorage.setItem(storageKey(persistKey), remembered.toString());
    } catch {
      // storage unavailable
    }
  }, [persistKey, params]);

  const state = location.state as unknown;
  const update = useCallback(
    (patch: Partial<F>) => {
      const next = write({ ...read(latest.current), ...patch }, latest.current);
      latest.current = next;
      setParams(next, { replace: true, state });
    },
    [read, write, setParams, state],
  );
  return [read(params), update];
}
