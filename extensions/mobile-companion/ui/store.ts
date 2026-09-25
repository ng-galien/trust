import { create } from "zustand";

type Route = {
  project: string | null;
  item: string | null;
  version: string | null;
  app: string | null;
  reader: boolean;
  subject: string | null;
};

function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  return {
    project: params.get("project"),
    item: params.get("item"),
    version: params.get("version"),
    app: params.get("app"),
    reader: params.get("reader") === "1",
    subject: params.get("subject"),
  };
}

type MobileUiState = {
  route: Route;
  menuOpen: boolean;
  railOpen: boolean;
  draftDirty: boolean;
  theme: "light" | "dark";
  accent: "blue" | "violet";
  setRoute(search: string): void;
  openMenu(): void;
  closeMenu(): void;
  toggleRail(): void;
  setDraftDirty(dirty: boolean): void;
  setTheme(theme: "light" | "dark"): void;
  setAccent(accent: "blue" | "violet"): void;
};

const preference = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const theme = preference("trust-mobile-theme");
const accent = preference("trust-mobile-accent");

export const useMobileUi = create<MobileUiState>((set) => ({
  route: parseRoute(window.location.search),
  menuOpen: false,
  railOpen: preference("trust-mobile-rail-open") === "true",
  draftDirty: false,
  theme: theme === "dark" ? "dark" : "light",
  accent: accent === "violet" ? "violet" : "blue",
  setRoute: (search) => set({ route: parseRoute(search), menuOpen: false }),
  openMenu: () => set({ menuOpen: true }),
  closeMenu: () => set({ menuOpen: false }),
  toggleRail: () =>
    set((state) => {
      const railOpen = !state.railOpen;
      try {
        window.localStorage.setItem("trust-mobile-rail-open", String(railOpen));
      } catch {}
      return { railOpen };
    }),
  setDraftDirty: (dirty) => set({ draftDirty: dirty }),
  setTheme: (value) => {
    try {
      window.localStorage.setItem("trust-mobile-theme", value);
    } catch {}
    set({ theme: value });
  },
  setAccent: (value) => {
    try {
      window.localStorage.setItem("trust-mobile-accent", value);
    } catch {}
    set({ accent: value });
  },
}));
