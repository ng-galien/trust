import type { shared as en } from "../en/shared.js";
import type { Translation } from "../types.js";

export const shared: Translation<typeof en> = {
  versions: {
    label: "Version",
    exact: "Version publiée sélectionnée",
    discardFirst: "Publiez ou abandonnez les modifications avant de changer de version.",
    immutable: "Les versions publiées sont immuables. Modifiez le tag de version pour publier une nouvelle version.",
    draft:
      "Brouillon non publié d’une nouvelle version. Les modifications restent dans cet éditeur jusqu’à la publication.",
    publish: "Publier la version",
    publishing: "Publication…",
  },
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
    wrap: "Retour à la ligne",
    wrapHint: "Affichage uniquement : ne modifie pas la source",
    formatHint: "Replier les étapes longues sur des lignes de continuation (Maj+Alt+F)",
    unavailable: "Serveur de langage indisponible",
    editorUnavailable: "Éditeur indisponible",
  },
};
