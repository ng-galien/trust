import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { Language } from "../i18n/index.js";

/* User preferences — one persisted Zustand store (localStorage), read through selectors. */

export type ThemePreference = "light" | "dark" | "system";
/** Interface density: the operator mode shows the essentials and the actions, the expert mode everything. */
export type Density = "operator" | "expert";
/** Display order of the Plan checklist: the Procedure order, or reversed (last Scenarios first). */
export type ChecklistOrder = "forward" | "reverse";
type SidebarMode = "extended" | "compact";

export interface Preferences {
  theme: ThemePreference;
  /** Interface language (BCP 47 tag among the supported dictionaries). */
  language: Language;
  /** Current environment: the context every run, engagement and "runnable" mark refers to. Never in the URL. */
  environment: string | null;
  density: Density;
  sidebarMode: SidebarMode;
  expandedAnchors: string[];
  editorFontSize: number;
  /** Item overlays: whether the right-hand inspector is shown — the user's choice, kept across items and sessions. */
  inspectorOpen: boolean;
  /** Dry-run cockpit: shown or not, and its width in px — resized by the user. */
  cockpitOpen: boolean;
  cockpitWidth: number;
  /** Documentation: whether the contents tree is shown. */
  docsNavOpen: boolean;
  planChecklistOrder: ChecklistOrder;
}

const storageKey = "trust.ui.preferences";

const defaults: Preferences = {
  theme: "system",
  language: "en",
  environment: null,
  density: "operator",
  sidebarMode: "extended",
  expandedAnchors: [],
  editorFontSize: 13,
  inspectorOpen: true,
  cockpitOpen: true,
  cockpitWidth: 400,
  docsNavOpen: true,
  planChecklistOrder: "forward",
};

/** Reads a value written before the store existed (a bare Preferences object) as a versioned record. */
const storage = createJSONStorage<Preferences>(() => ({
  getItem: (name) => {
    const raw = localStorage.getItem(name);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return "state" in parsed ? raw : JSON.stringify({ state: parsed, version: 0 });
    } catch {
      return null;
    }
  },
  setItem: (name, value) => localStorage.setItem(name, value),
  removeItem: (name) => localStorage.removeItem(name),
}));

export const usePreferencesStore = create<Preferences>()(
  persist(() => defaults, { name: storageKey, storage, merge: (persisted, current) => ({ ...current, ...(persisted as Partial<Preferences>) }) }),
);

export function usePreferences(): Preferences {
  return usePreferencesStore();
}

export function usePreference<K extends keyof Preferences>(key: K): Preferences[K] {
  return usePreferencesStore((state) => state[key]);
}

export function updatePreferences(patch: Partial<Preferences>) {
  usePreferencesStore.setState(patch);
}

export function toggleAnchor(anchor: string, expanded?: boolean) {
  const { expandedAnchors } = usePreferencesStore.getState();
  const has = expandedAnchors.includes(anchor);
  const next = expanded ?? !has;
  if (next === has) return;
  usePreferencesStore.setState({ expandedAnchors: next ? [...expandedAnchors, anchor] : expandedAnchors.filter((entry) => entry !== anchor) });
}

const systemDark = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function useResolvedTheme(): "light" | "dark" {
  const theme = usePreference("theme");
  const prefersDark = useSyncExternalStore(
    (listener) => {
      systemDark?.addEventListener("change", listener);
      return () => systemDark?.removeEventListener("change", listener);
    },
    () => systemDark?.matches ?? false,
    () => false,
  );
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

/** True in expert mode — the only switch the views use to reveal technical detail. */
export function useExpert(): boolean {
  return usePreferencesStore((state) => state.density === "expert");
}
