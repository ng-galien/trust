import { useCallback, useMemo, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";

/* The view state of an item overlay (active tab, selected element) lives in the URL:
   leaving for a related item and coming back (Escape) restores the exact view.
   These keys are ephemeral — never persisted with the collection filters, never kept
   in the links that go back to the collection. */

export const EPHEMERAL_PARAMS = ["tab", "sel", "from"] as const;

/** Search string without the overlay-only keys — what the collection behind the overlay uses. */
export function stripEphemeral(search: string): string {
  const next = new URLSearchParams(search);
  for (const key of EPHEMERAL_PARAMS) next.delete(key);
  const value = next.toString();
  return value ? `?${value}` : "";
}

export interface OverlayViewState<T extends string> {
  tab: T;
  sel: string | undefined;
  /** One router update for both keys — chained calls in the same tick stay consistent. */
  update: (patch: { tab?: T; sel?: string | undefined }) => void;
  setTab: (tab: T) => void;
  setSel: (sel: string | undefined) => void;
}

export function useOverlayViewState<T extends string>(tabs: readonly T[], defaultTab: T): OverlayViewState<T> {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const latest = useRef(params);
  latest.current = params;
  const state = location.state as unknown;

  const rawTab = params.get("tab");
  const tab = (rawTab && (tabs as readonly string[]).includes(rawTab) ? rawTab : defaultTab) as T;
  const sel = params.get("sel") ?? undefined;

  const update = useCallback(
    (patch: { tab?: T; sel?: string | undefined }) => {
      const next = new URLSearchParams(latest.current);
      if ("tab" in patch) {
        if (patch.tab === undefined || patch.tab === defaultTab) next.delete("tab");
        else next.set("tab", patch.tab);
      }
      if ("sel" in patch) {
        if (patch.sel === undefined || patch.sel === "") next.delete("sel");
        else next.set("sel", patch.sel);
      }
      latest.current = next;
      setParams(next, { replace: true, state });
    },
    [setParams, state, defaultTab],
  );

  return useMemo(
    () => ({
      tab,
      sel,
      update,
      setTab: (value: T) => update({ tab: value }),
      setSel: (value: string | undefined) => update({ sel: value }),
    }),
    [tab, sel, update],
  );
}
