import type { docs as en } from "../en/docs.js";
import type { Translation } from "../types.js";

export const docs: Translation<typeof en> = {
  title: "Documentation",
  crumb: "Documentation",
  nav: {
    label: "Sommaire de la documentation",
    collapse: "Masquer le sommaire",
    expand: "Afficher le sommaire",
    toc: "Sur cette page",
    previous: "Précédent",
    next: "Suivant",
    inThisSection: "Dans cette section",
    home: "Introduction",
  },
  search: {
    label: "Rechercher dans la documentation",
    placeholder: "Rechercher dans la documentation…",
    noResult: "Aucune page ne correspond.",
    group: "Documentation",
  },
  page: {
    notFound: "Cette page de documentation n'existe pas.",
    backHome: "Retour à l'introduction",
    fallback: "Cette page n'est pas encore traduite ; elle est affichée en anglais.",
    draft: "Brouillon — cette page est en cours d'écriture ; la structure est définitive, le contenu non.",
    openScreen: "Ouvrir l'écran",
  },
  details: {
    expert: "Expert",
    expertHint: "Détail affiché par défaut en mode expert",
  },
  snippet: {
    copy: "Copier",
    copied: "Copié",
    openOperation: "Ouvrir l'opération",
    openProcedure: "Ouvrir la procédure",
    fragment: "Extrait",
    lines: "{{count}} lignes",
  },
  screenshot: {
    missing: "La capture « {{id}} » n'a pas encore été produite (lancer `npm run docs:capture` dans apps/trust-web).",
    legend: "Légende",
    callout: "Repère {{n}}",
    mode: "mode {{mode}}",
    operator: "opérateur",
    expert: "expert",
  },
  diagram: {
    loading: "Rendu du schéma…",
    error: "Le schéma n'a pas pu être rendu : {{error}}",
  },
  visual: {
    expand: "Afficher en plein écran",
    diagram: "Schéma agrandi",
    screenshot: "Capture agrandie",
    figure: "Illustration agrandie",
  },
  callout: {
    note: "Note",
    tip: "Conseil",
    warning: "Attention",
    rule: "Règle",
  },
  language: {
    roots: "Racines",
    operators: "Opérateurs",
    functions: "Fonctions",
    math: "Fonctions Math",
    collections: "Méthodes de collection",
    strings: "Méthodes de chaîne",
  },
  figures: {
    model: {
      alt: "Le modèle TRUST : les objets écrits en haut, ce que produit un Plan qui tourne en bas",
      design: "Définitions",
      run: "Exécution",
      operation: "Opération",
      procedure: "Procédure",
      scenario: "Scénario",
      check: "Check",
      usedBy: "utilisée par",
      engagedAs: "crée",
      plan: "Plan",
      attempt: "Tentative",
      facts: "Facts",
      verdict: "Qualification",
      revision: "Révision",
      cascade: "rouvre",
    },
    architecture: {
      alt: "L'agent et le Runner partagent un système d'agent tandis que TRUST reste l'autorité",
      agentSystem: "Système d'agent",
      agent: "Agent",
      skill: "Runner",
      runtime: "Autorité TRUST",
      interface: "Opérateur",
      external: "Systèmes externes",
      mcpRead: "lit",
      checkUri: "délègue",
      admission: "demande",
      facts: "observe",
      execute: "agit",
      rpc: "pilote",
    },
  },
  glossary: {
    label: "Glossaire",
    agent: {
      term: "Agent",
      definition:
        "Un système d'intelligence artificielle qui reçoit un objectif, raisonne sur le travail et choisit des actions, et dont le propre récit du résultat n'est pas une preuve.",
    },
    tool: {
      term: "Outil",
      definition:
        "Un moyen pour un agent d'interagir avec quelque chose en dehors de son modèle, comme un fichier, une commande, une application ou un service distant.",
    },
    operator: {
      term: "Opérateur",
      definition:
        "La personne qui engage et suit un Plan, contrôle son Environnement et décide si un Plan escaladé peut reprendre.",
    },
    operation: {
      term: "Opération",
      definition:
        "Une action définie à l'avance sur un système externe, qui précise ses Inputs, ses étapes ordonnées et ses champs produits, et ne décide jamais si un Check est réussi.",
    },
    check: {
      term: "Check",
      definition:
        "Une question à laquelle le travail doit répondre, qui nomme une Opération, l'objet concerné et la règle qui décide si le résultat attendu est établi.",
    },
    scenario: {
      term: "Scénario",
      definition:
        "Un groupe de Checks satisfait quand chaque Check est validé, et qui peut exiger d'autres Scénarios avant lui.",
    },
    procedure: {
      term: "Procédure",
      definition:
        "La définition écrite par des humains de ce qui doit être établi, dans quel ordre et dans quelles limites.",
    },
    plan: {
      term: "Plan",
      definition:
        "Une utilisation concrète d'une Procédure, qui conserve les entrées, l'état courant de chaque Check et l'historique du travail.",
    },
    session: {
      term: "Session",
      definition: "Le travail ouvert sur un Plan, dont la fermeture conserve le Plan et son historique.",
    },
    attempt: {
      term: "Tentative",
      definition:
        "Une exécution autorisée de l'Opération d'un Check, par l'agent sur un Plan live ou à partir des observations de l'opérateur sur un dry-run.",
    },
    fact: {
      term: "Fact",
      definition: "La valeur acceptée d'un champ produit d'une Opération.",
    },
    verdict: {
      term: "Verdict",
      definition:
        "Le résultat de la qualification : le Check est validé ou non, avec une raison exploitable par l'agent.",
    },
    qualification: {
      term: "Qualification",
      definition:
        "L'évaluation des gardes typées d'un Check sur les Facts acceptés pour calculer son verdict et sa raison, effectuée uniquement par TRUST.",
    },
    cascade: {
      term: "Cascade",
      definition:
        "Le recalcul d'un Check après de nouveaux Facts, qui rouvre chaque Check qui en dépend via les prérequis de Scénario et les références de champs.",
    },
    environment: {
      term: "Environnement",
      definition:
        "Le lieu et le contexte d'accès nommés dans lesquels une action s'exécute, qui peut fournir des répertoires, des URL, des valeurs ordinaires et des références à des credentials.",
    },
    credential: {
      term: "Credential",
      definition:
        "Un secret que le runtime stocke en écriture seule, qu'un Environnement référence et qui n'est jamais affiché ni injecté pendant un dry-run.",
    },
    runner: {
      term: "Runner",
      definition:
        "Le composant qui réalise une action définie à l'avance pour le Check et l'Opération exacts fournis par TRUST, et rapporte ce qu'il a observé sans décider de la réussite.",
    },
    skill: {
      term: "Skill",
      definition:
        "L'intégration qu'un agent installe pour travailler avec TRUST, avec les instructions pour suivre les Plans et le Runner qui exécute les Checks.",
    },
    delegation: {
      term: "Délégation",
      definition: "Le fait de confier un travail à un Plan enfant.",
    },
    dryRun: {
      term: "Dry-run",
      definition:
        "Un Plan répété par l'opérateur avec les mêmes Checks et les mêmes règles, des Facts saisis à la main et aucune valeur d'Environnement transmise à un Runner.",
    },
    snapshot: {
      term: "Snapshot",
      definition:
        "L'enregistrement immuable d'une qualification, avec ses Facts acceptés, son verdict, sa raison et le delta de checklist qu'elle a provoqué.",
    },
    revision: {
      term: "Révision",
      definition:
        "L'état d'un Plan après un lot de Facts accepté, de sorte que chaque acceptation produit une nouvelle révision.",
    },
    intent: {
      term: "Intention",
      definition:
        "La courte déclaration de l'agent sur le travail qu'il prévoit ensuite, qui ne sert jamais de preuve et n'influence pas la qualification.",
    },
    escalation: {
      term: "Escalade",
      definition:
        "Un arrêt enregistré lorsque l'agent ne peut pas continuer dans les limites de son autorité, qui laisse le Check ouvert et rend la décision à un opérateur.",
    },
    otlp: {
      term: "OTLP",
      definition:
        "Le protocole OpenTelemetry par lequel le Runner rapporte les Facts d'un Plan live sous forme de spans de trace.",
    },
    mcp: {
      term: "MCP",
      definition:
        "Le Model Context Protocol par lequel un agent lit les Plans et les Checks, en appelant les mêmes fonctions du runtime que RPC.",
    },
    jsonata: {
      term: "JSONata",
      definition:
        "Le langage d'expression de l'étape Produce, avec une expression fermée qui transforme Input, Environnement et résultats d'étapes en champs produits.",
    },
    grant: {
      term: "Autorisation",
      definition: "Un droit que TRUST accorde à une extension.",
    },
    vocabulary: {
      term: "Vocabulaire",
      definition: "Un objet du catalogue qui déclare des termes, leur catégorie, leur définition et des mots rejetés.",
    },
    term: {
      term: "Terme",
      definition: "Un mot ou une expression qu'un vocabulaire déclare avec sa catégorie et une seule définition.",
    },
  },
};
