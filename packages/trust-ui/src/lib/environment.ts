import { useEffect } from "react";

import type { EnvironmentEntry } from "../types.js";
import { updatePreferences, usePreference } from "./preferences.js";
import { useEnvironments } from "./runtime-context.js";

/* The current environment — a user context like the language: chosen in the header, remembered as a
   preference, never part of an address. Runs default to it, engagements propose it, "runnable" marks
   are read against it. When the preferred name no longer exists, the first configured environment
   silently becomes current so the interface always has a stable answer. */

export function useCurrentEnvironment(): { name: string | null; entry: EnvironmentEntry | undefined; environments: EnvironmentEntry[]; loading: boolean; select: (name: string) => void } {
  const preferred = usePreference("environment");
  const environments = useEnvironments();
  const list = environments.data ?? [];
  const known = preferred !== null && list.some((entry) => entry.name === preferred);
  const name = known ? preferred : (list[0]?.name ?? null);
  useEffect(() => {
    if (environments.isSuccess && name !== preferred) updatePreferences({ environment: name });
  }, [environments.isSuccess, name, preferred]);
  return { name, entry: list.find((entry) => entry.name === name), environments: list, loading: environments.isLoading, select: (next) => updatePreferences({ environment: next }) };
}
