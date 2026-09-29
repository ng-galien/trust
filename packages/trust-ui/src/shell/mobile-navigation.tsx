import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useLocation } from "react-router";

/* Phone navigation of the management pages: the header toggle opens the extended sidebar as a drawer, which closes
   on navigation, Escape or a tap outside. Wider screens keep the persistent sidebar and its compact preference. */

export const PHONE_QUERY = "(max-width: 640px)";

/** Extension management pages, as opposed to an extension's own workspace. */
export const isManagementPath = (pathname: string) =>
  /^\/extensions(\/(sources|packages|settings)(\/.*)?)?\/?$/.test(pathname);

interface MobileNavigation {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

const MobileNavigationContext = createContext<MobileNavigation>({ open: false, setOpen: () => {} });

export const useMobileNavigation = () => useContext(MobileNavigationContext);

/** Whether the viewport is phone-sized, following resizes. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

export function MobileNavigationProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  // Following a link closes the drawer: the state is adjusted during render when the page changes.
  const [shownFor, setShownFor] = useState(pathname);
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return <MobileNavigationContext.Provider value={{ open, setOpen }}>{children}</MobileNavigationContext.Provider>;
}
