import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

/* Overlays opened from another overlay close back to it: relation links carry their origin
   in the router state, and the item's close action follows it. */

export interface OriginState { from?: string }

/** Router state to attach to a link that leaves the current item for a related one. */
export function useOrigin(): OriginState {
  const location = useLocation();
  return { from: `${location.pathname}${location.search}` };
}

/** Close action: back to the origin item when there is one, else to the resource list. */
export function useCloseTo(fallback: string): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as OriginState | null)?.from;
  return useCallback(() => navigate(from ?? fallback), [navigate, from, fallback]);
}
