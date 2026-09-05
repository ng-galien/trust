export const extensions = {
  title: "Extensions", description: "Gérer les extensions installées et ouvrir leur espace de travail.",
  refresh: "Actualiser", prepare: "Préparer", start: "Démarrer", stop: "Arrêter", open: "Ouvrir l’espace de travail",
  empty: "Aucune extension installée.", loading: "Chargement de l’extension…", unavailable: "Cette extension est indisponible. Démarrez-la depuis Extensions.",
  failed: "Impossible de charger l’extension.", actionFailed: "L’action a échoué. Actualisez pour voir l’état courant de l’extension.", retry: "Réessayer", back: "Toutes les extensions",
  states: { STOPPED: "Arrêtée", PREPARING: "Préparation", STARTING: "Démarrage", RUNNING: "En cours", STOPPING: "Arrêt", FAILED: "Échec" },
} as const;
