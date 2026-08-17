export const overview = {
  home: {
    crumb: "Overview",
    title: "Overview",
    subtitle: "What TRUST knows right now: the catalog, the Plans in flight and the latest verdicts.",
    tiles: {
      operations: "Operations",
      operationsHint: "compiled, runnable",
      procedures: "Procedures",
      proceduresHint: "published versions",
      plans: "Plans",
      dryRuns: "Dry-runs",
      inProgress: "{{count}} in progress",
    },
    inFlight: {
      kicker: "In flight",
      nothing: "Nothing is running. Agents engage Plans through the skill; you can rehearse a Procedure as a dry-run.",
      meta: "{{procedure}} · {{environment}} · rev {{revision}}",
    },
    runtime: {
      kicker: "Runtime",
      healthy: "healthy",
      checking: "checking…",
      unreachable: "unreachable",
      environments: "Environments",
      openSessions: "Open sessions",
      updates: "Updates",
      live: "Live",
      polling: "Polling",
    },
    latest: {
      kicker: "Latest verdicts",
      link: "Check history",
      reading: "Reading the runtime…",
      none: "No verdict yet.",
    },
  },
} as const;
