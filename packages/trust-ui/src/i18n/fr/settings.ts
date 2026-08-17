import type { settings as en } from "../en/settings.js";
import type { Translation } from "../types.js";

export const settings: Translation<typeof en> = {
  home: {
    crumb: "Paramètres",
    title: "Paramètres",
    subtitle: "Paramètres de cette interface uniquement — ils restent dans ce navigateur. Les environnements et credentials se trouvent sous Run.",
    appearance: {
      title: "Apparence",
      hint: "Deux thèmes sobres, ou suivre le système.",
      themeLabel: "Thème",
      light: "Clair",
      dark: "Sombre",
      system: "Système",
    },
    language: {
      title: "Langue",
      hint: "Langue de cette interface.",
      label: "Langue",
    },
    editor: {
      title: "Éditeur Gherkin",
      hint: "Partagé par les éditeurs d'Operation et de Procedure et par la source hydratée du Plan.",
      unit: "px",
    },
    runtime: {
      title: "Runtime",
      hint: "Le shell web appelle les mêmes fonctions RPC publiques que tout autre hôte.",
    },
  },
};
