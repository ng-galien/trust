import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { usePreferencesStore } from "../lib/preferences.js";
import { en } from "./en/index.js";
import { fr } from "./fr/index.js";

/* Internationalisation — react-i18next. English is the default language;
   every user-facing string of the interface goes through `t()` with a key from `src/i18n/en/*`;
   other languages (`src/i18n/fr/*`) are typed against the English dictionary so no key can be missing.
   The language is a user preference; the store drives i18next. */

export const languages = ["en", "fr"] as const;
export type Language = (typeof languages)[number];

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}

void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: usePreferencesStore.getState().language,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

usePreferencesStore.subscribe((state, previous) => {
  if (state.language !== previous.language) void i18next.changeLanguage(state.language);
});

export { i18next };
