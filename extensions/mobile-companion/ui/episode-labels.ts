import type { InvocationView } from "@trust/extension-sdk";

const frenchMissions: Record<string, string> = {
  model: "Modèle et contrat",
  interface: "Interface mobile",
  verification: "Vérifications publiques",
  "reading-model": "Hiérarchie et libellés",
  "reading-interface": "Lecture mobile",
  "reading-verification": "Contrôles publics",
  "navigation-model": "Liens du sujet",
  "navigation-interface": "Navigation mobile",
  "navigation-verification": "Contrôles de lecture",
  "subject-model": "Structure du sujet",
  "subject-interface": "Parcours de lecture",
  "subject-verification": "Vérification et mise en service",
};

const frenchPlans: Record<string, string> = {
  "Enriched delegation: first vertical slice": "Délégation enrichie · première tranche",
  "Mobile companion: readable topics and episodes": "Lecture des sujets et épisodes",
  "Mobile companion: navigate article and linked work": "Navigation du sujet et des contenus",
};

const frenchChecks: Record<string, string> = {
  "read work report": "Vérification du résultat remis",
  "confirm milestone": "Clôture du jalon",
  "read decision": "Décision observée",
};

const frenchReasons: Record<string, string> = {
  "the assigned lot has a validated report": "Le résultat remis pour cette mission a été vérifié.",
  "the three implementation lots have an explicit outcome": "Les trois missions ont un résultat vérifié.",
  "the response approves the next step": "La réponse autorise l’étape suivante.",
  "the response did not approve the next step": "La réponse n’autorise pas l’étape suivante.",
  "scenario lots has no satisfied current requirement": "la validation des missions enfants",
};

function readableIdentifier(value: string): string {
  const words = value.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toLocaleUpperCase() + words.slice(1) : value;
}

export function missionLabel(invocation: InvocationView, french: boolean): string {
  const id = invocation.mission?.id ?? invocation.name;
  return french ? (frenchMissions[id] ?? readableIdentifier(id)) : readableIdentifier(id);
}

export function planLabel(value: string, french: boolean): string {
  return french ? (frenchPlans[value] ?? value) : value;
}

export function checkLabel(value: string, french: boolean): string {
  return french ? (frenchChecks[value] ?? readableIdentifier(value)) : readableIdentifier(value);
}

export function reasonLabel(value: string, french: boolean): string {
  return french ? (frenchReasons[value] ?? value) : value;
}
