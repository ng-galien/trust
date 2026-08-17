import { Languages, Monitor, Moon, Sun, Type } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Language } from "../../i18n/index.js";
import { type ThemePreference, updatePreferences, usePreferences } from "../../lib/preferences.js";
import { useHealth } from "../../lib/runtime-context.js";
import { StatusBadge } from "../../ui/badge.js";
import { PageHeader } from "../../ui/breadcrumb.js";
import { SegmentedControl } from "../../ui/controls.js";
import { Expert } from "../../ui/expert.js";
import { NumberStepper } from "../../ui/schema.js";

/* Settings — this interface (theme, language, editor) and the runtime it talks to. */

export function SettingsHome() {
  const { t } = useTranslation();
  const preferences = usePreferences();
  const health = useHealth();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg">
      <PageHeader crumbs={[{ label: "TRUST", to: "/overview" }, { label: t("settings.home.crumb") }]} title={t("settings.home.title")} />
      <div className="grid gap-4 p-6 md:grid-cols-2 [&>*]:min-w-0">
        <Section title={t("settings.home.appearance.title")}>
          <SegmentedControl<ThemePreference> ariaLabel={t("settings.home.appearance.themeLabel")} value={preferences.theme} onChange={(theme) => updatePreferences({ theme })} options={[
            { value: "light", label: <><Sun size={13} /> {t("settings.home.appearance.light")}</> },
            { value: "dark", label: <><Moon size={13} /> {t("settings.home.appearance.dark")}</> },
            { value: "system", label: <><Monitor size={13} /> {t("settings.home.appearance.system")}</> },
          ]} />
        </Section>
        <Section title={t("settings.home.language.title")}>
          <div className="flex items-center gap-3">
            <Languages size={14} className="text-muted" />
            <SegmentedControl<Language> ariaLabel={t("settings.home.language.label")} value={preferences.language} onChange={(language) => updatePreferences({ language })} options={[
              { value: "en", label: <>🇬🇧 English</> },
              { value: "fr", label: <>🇫🇷 Français</> },
            ]} />
          </div>
        </Section>
        <Section title={t("settings.home.editor.title")}>
          <div className="flex items-center gap-3">
            <Type size={14} className="text-muted" />
            <NumberStepper id="editor-font-size" spec={{ type: "integer", minimum: 10, maximum: 20 }} value={preferences.editorFontSize} onChange={(value) => { if (typeof value === "number") updatePreferences({ editorFontSize: Math.min(20, Math.max(10, value)) }); }} />
            <span className="text-body text-muted">{t("settings.home.editor.unit")}</span>
          </div>
        </Section>
        <Section title={t("settings.home.runtime.title")}>
          <div className="flex items-center gap-2 text-body-lg"><StatusBadge state={health.data ? "OK" : health.isLoading ? "…" : "UNAVAILABLE"} /><span className="mono text-muted">{window.location.origin}<Expert> · /rpc · /health · /otlp</Expert></span></div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={`rounded-(--radius-3) border border-border bg-surface p-4 ${className ?? ""}`}>
      <span className="kicker">{title}</span>
      <div className="mb-3" />
      {children}
    </section>
  );
}
