import type { history as en } from "../en/history.js";
import type { Translation } from "../types.js";

export const history: Translation<typeof en> = {
  home: {
    crumb: "Historique des Checks",
    title: "Historique des Checks",
    subtitle: "Chaque verdict jamais calculé par TRUST, sur les Plans et les dry-runs — instantanés immuables, du plus récent au plus ancien. Creusez, filtrez, auditez.",
    searchPlaceholder: "Rechercher dans les verdicts chargés, ou choisir des filtres…",
    facets: {
      verdict: "Verdict",
      validated: "Validé",
      notValidated: "Non validé",
      mode: "Mode",
      livePlans: "Plans live",
      dryRuns: "Dry-runs",
      procedure: "Procedure",
      plan: "Plan",
    },
    groupNone: "Aucun",
    groupPlan: "Plan",
    groupDay: "Jour",
    sortRecent: "Plus récents d'abord",
    emptyTitleNoMatch: "Aucun verdict chargé ne correspond à la recherche",
    emptyTitleNone: "Aucun verdict pour l'instant",
    emptyBodyNoMatch: "Ajustez la recherche, ou chargez d'autres pages.",
    emptyBodyNone: "Les verdicts apparaissent dès qu'un Check est finalisé dans un Plan ou un dry-run.",
    loaded: "{{verdicts}} chargés",
  },
  table: {
    columns: {
      when: "Quand",
      verdict: "Verdict",
      check: "Check",
      plan: "Plan",
      reason: "Raison",
      facts: "Facts",
    },
    reopened: " · rouvert {{checks}}",
    attempt: "{{reasonCode}} · tentative {{handle}}",
  },
};
