import { type RefObject, useEffect } from "react";

/** Closes a transient surface (menu, popover, picker) on outside pointer-down or Escape while it is open. */
export function useDismiss(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  detachedSurface?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !detachedSurface?.current?.contains(target)) onDismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, root, onDismiss, detachedSurface]);
}
