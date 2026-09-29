export const extensions = {
  title: "Extensions",
  refresh: "Refresh state",
  empty: "No extensions installed.",
  loading: "Loading extension…",
  unavailable: "This extension is unavailable. Start it from Extensions.",
  failed: "The extension could not be loaded.",
  retry: "Retry",
  back: "All extensions",
  states: {
    STOPPED: "Stopped",
    PREPARING: "Preparing",
    STARTING: "Starting",
    RUNNING: "Running",
    STOPPING: "Stopping",
    FAILED: "Failed",
  },
} as const;
