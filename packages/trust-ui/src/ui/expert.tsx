import type { ReactNode } from "react";

import { useExpert } from "../lib/preferences.js";

/** Renders its children in expert mode only: identifiers, digests, technical tabs, secondary relations. */
export function Expert({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return <>{useExpert() ? children : fallback}</>;
}
