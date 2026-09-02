import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../styles.css";
import "../i18n/index.js";

import { Languages, Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { HashRouter, Link, Navigate, Route, Routes } from "react-router";

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
          <Link to="/docs" className="group flex items-center gap-2.5 rounded-(--radius-2) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <span className="grid h-6 w-6 place-items-center rounded-(--radius-1) bg-surface-inverse text-body font-bold text-inverse transition-transform group-hover:-translate-y-px">T</span>
            <span className="text-ui font-bold tracking-[0.18em]">TRUST</span>
            <span className="text-ui text-muted transition-colors group-hover:text-text">· {t("docs.title")}</span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <span className="flex items-center gap-1.5">
              <Languages size={15} aria-hidden="true" className="text-faint" />
              <SegmentedControl<Language> ariaLabel={t("settings.home.language.label")} size="sm" value={language} onChange={(next) => updatePreferences({ language: next })} options={[{ value: "fr", label: <>FR</>, title: "Français" }, { value: "en", label: <>EN</>, title: "English" }]} />
            </span>
            <a
              href="https://github.com/ng-galien/trust"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              title="GitHub"
              className="inline-flex h-8 w-8 items-center justify-center rounded-(--radius-2) text-muted transition-colors hover:bg-surface-3 hover:text-text"
            >
              <GitHubMark />
            </a>
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

function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.22c-3.21.7-3.89-1.36-3.89-1.36-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.26-1.28-5.26-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.95 10.95 0 0 1 5.76 0c2.19-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.38-5.27 5.67.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.79.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}
