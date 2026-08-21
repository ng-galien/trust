import type { shared as en } from "../en/shared.js";
import type { Translation } from "../types.js";

export const shared: Translation<typeof en> = {
  resourceHome: {
    visibleOfTotal: "{{visible}} sur {{total}}",
    display: "Affichage",
    cards: "Cartes",
    list: "Liste",
    byGroup: "par {{group}}",
    view: "Vue",
    viewMode: "Mode d'affichage",
    groupBy: "Grouper par",
    sortBy: "Trier par",
  },
  resourceOverlay: {
    views: "Vues",
    hideDetails: "Masquer les détails",
    showDetails: "Afficher les détails",
  },
  gherkinEditor: {
    loading: "Chargement de l'éditeur…",
    format: "Formater la source",
    formatHint: "Replier les étapes longues sur des lignes de continuation (Maj+Alt+F)",
    unavailable: "Serveur de langage indisponible",
  },
};
