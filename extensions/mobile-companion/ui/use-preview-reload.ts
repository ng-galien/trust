import { useEffect, useState } from "react";
import { useMobileUi } from "./store";

export function usePreviewReload(apiBase: string, enabled: boolean) {
  const draftDirty = useMobileUi((state) => state.draftDirty);
  const [updatePending, setUpdatePending] = useState(false);
  useEffect(() => {
    if (updatePending && !draftDirty) window.location.reload();
  }, [updatePending, draftDirty]);
  useEffect(() => {
    if (!enabled) return;
    const url = `${apiBase.replace(/\/api$/, "")}/assets/preview-version.json`;
    let active = true;
    let current: number | null = null;
    const check = async () => {
      try {
        const response = await fetch(`${url}?check=${Date.now()}`, { cache: "no-store" });
        if (!response.ok || !active) return;
        const value = (await response.json()) as { revision?: unknown };
        if (typeof value.revision !== "number") return;
        if (current !== null && value.revision !== current) {
          if (useMobileUi.getState().draftDirty) setUpdatePending(true);
          else window.location.reload();
        }
        current = value.revision;
      } catch {
        // A rebuild may briefly replace the asset; the next poll checks again.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [apiBase, enabled]);
  return updatePending;
}
