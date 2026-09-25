const kinds = {
  fr: {
    progress: "Avancement",
    explanation: "Explication",
    question: "Question",
    decision: "Décision",
    confirmation: "Confirmation",
    review: "Relecture",
    document: "Document",
  },
  en: {
    progress: "Progress",
    explanation: "Explanation",
    question: "Question",
    decision: "Decision",
    confirmation: "Confirmation",
    review: "Review",
    document: "Document",
  },
};

const statuses = {
  fr: { active: "Actif", paused: "En pause", unavailable: "Indisponible" },
  en: { active: "Active", paused: "Paused", unavailable: "Unavailable" },
};

export function kindLabel(kind: string, locale: string): string {
  const catalog: Record<string, string> = locale.startsWith("fr") ? kinds.fr : kinds.en;
  return catalog[kind] ?? kind;
}

export function statusLabel(status: string, locale: string): string {
  const catalog: Record<string, string> = locale.startsWith("fr") ? statuses.fr : statuses.en;
  return catalog[status] ?? status;
}
