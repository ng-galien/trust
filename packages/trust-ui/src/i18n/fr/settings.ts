import type { settings as en } from "../en/settings.js";
import type { Translation } from "../types.js";

export const settings: Translation<typeof en> = {
  home: {
    crumb: "Paramètres",
    title: "Paramètres",
    appearance: {
      title: "Apparence",
      themeLabel: "Thème",
      light: "Clair",
      dark: "Sombre",
      system: "Système",
    },
    language: {
      title: "Langue",
      label: "Langue",
    },
    editor: {
      title: "Éditeur Gherkin",
      unit: "px",
    },
    runtime: {
      title: "Runtime",
    },
  },
};
