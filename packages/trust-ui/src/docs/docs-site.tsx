import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../styles.css";
import "../i18n/index.js";

import { Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { HashRouter, Navigate, Route, Routes } from "react-router";

import type { Language } from "../i18n/index.js";
import { updatePreferences, usePreference, useResolvedTheme } from "../lib/preferences.js";
import { IconButton } from "../ui/button.js";
import { SegmentedControl } from "../ui/controls.js";
import { DocsArea } from "./docs-area.js";

/* The documentation as a site of its own: no runtime, no interface — the same pages, a hash router
   (works from a file:// URL), a minimal header with the language and the theme. Built by
   `apps/trust-web` (`npm run build:docs`) into one self-contained HTML file. */

export function TrustDocumentation() {
  const { t } = useTranslation();
  const theme = useResolvedTheme();
  const language = usePreference("language");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <HashRouter>
      <div className="flex h-full flex-col overflow-hidden bg-bg text-text">
        <header className="flex h-(--header-h) shrink-0 items-center gap-4 border-b border-border bg-surface px-4">
          <span className="flex items-center gap-2.5">
            <span className="grid h-6 w-6 place-items-center rounded-(--radius-1) bg-surface-inverse text-body font-bold text-inverse">T</span>
            <span className="text-ui font-bold tracking-[0.18em]">TRUST</span>
            <span className="text-ui text-muted">· {t("docs.title")}</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <SegmentedControl<Language> ariaLabel={t("settings.home.language.label")} size="sm" value={language} onChange={(next) => updatePreferences({ language: next })} options={[{ value: "en", label: <>🇬🇧 English</> }, { value: "fr", label: <>🇫🇷 Français</> }]} />
            <IconButton label={theme === "dark" ? t("shell.theme.useLight") : t("shell.theme.useDark")} onClick={() => updatePreferences({ theme: theme === "dark" ? "light" : "dark" })}>
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </IconButton>
          </div>
        </header>
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <Routes>
            <Route path="/docs/*" element={<DocsArea />} />
            <Route path="*" element={<Navigate to="/docs" replace />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
