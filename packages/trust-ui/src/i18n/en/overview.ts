export const overview = {
  home: {
    crumb: "Overview",
    title: "Overview",
    tiles: {
      operations: "Operations",
      procedures: "Procedures",
      plans: "Plans",
      dryRuns: "Dry-runs",
      inProgress: "{{count}} in progress",
    },
    inFlight: {
      kicker: "In flight",
      nothing: "Nothing is running.",
      meta: "{{procedure}} · {{environment}}",
      metaRevision: "{{procedure}} · {{environment}} · rev {{revision}}",
    },
    runtime: {
      kicker: "Runtime",
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
