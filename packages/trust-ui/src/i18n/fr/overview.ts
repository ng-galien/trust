import type { overview as en } from "../en/overview.js";
import type { Translation } from "../types.js";

export const overview: Translation<typeof en> = {
  home: {
    crumb: "Vue d'ensemble",
    title: "Vue d'ensemble",
    tiles: {
      operations: "Opérations",
      procedures: "Procédures",
      plans: "Plans",
      dryRuns: "Dry-runs",
      inProgress: "{{count}} en cours",
    },
    inFlight: {
      kicker: "En cours",
      nothing: "Rien ne s'exécute.",
      meta: "{{procedure}} · {{environment}}",
      metaRevision: "{{procedure}} · {{environment}} · rév. {{revision}}",
    },
    runtime: {
      kicker: "Runtime",
      environments: "Environnements",
      openSessions: "Sessions ouvertes",
      updates: "Mises à jour",
      live: "Live",
      polling: "Polling",
    },
    latest: {
      kicker: "Derniers verdicts",
      link: "Historique des Checks",
      reading: "Lecture du runtime…",
      none: "Aucun verdict pour l'instant.",
    },
  },
};
