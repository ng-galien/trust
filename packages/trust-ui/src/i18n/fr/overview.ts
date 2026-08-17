import type { overview as en } from "../en/overview.js";
import type { Translation } from "../types.js";

export const overview: Translation<typeof en> = {
  home: {
    crumb: "Vue d'ensemble",
    title: "Vue d'ensemble",
    subtitle: "Ce que TRUST sait maintenant : le catalogue, les Plans en cours et les derniers verdicts.",
    tiles: {
      operations: "Opérations",
      operationsHint: "compilées, exécutables",
      procedures: "Procédures",
      proceduresHint: "versions publiées",
      plans: "Plans",
      dryRuns: "Dry-runs",
      inProgress: "{{count}} en cours",
    },
    inFlight: {
      kicker: "En cours",
      nothing: "Rien ne s'exécute. Les agents engagent des Plans via le skill ; vous pouvez répéter une Procedure en dry-run.",
      meta: "{{procedure}} · {{environment}} · rév. {{revision}}",
    },
    runtime: {
      kicker: "Runtime",
      healthy: "opérationnel",
      checking: "vérification…",
      unreachable: "injoignable",
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
