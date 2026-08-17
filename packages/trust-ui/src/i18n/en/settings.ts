export const settings = {
  home: {
    crumb: "Settings",
    title: "Settings",
    subtitle: "Settings of this interface only — they stay in this browser. Environments and credentials live under Run.",
    appearance: {
      title: "Appearance",
      hint: "Two sober themes, or follow the system.",
      themeLabel: "Theme",
      light: "Light",
      dark: "Dark",
      system: "System",
    },
    language: {
      title: "Language",
      hint: "Language of this interface.",
      label: "Language",
    },
    editor: {
      title: "Gherkin editor",
      hint: "Shared by the Operation and Procedure editors and the hydrated Plan source.",
      unit: "px",
    },
    runtime: {
      title: "Runtime",
      hint: "The web shell calls the same public RPC functions as every other host.",
    },
  },
} as const;
