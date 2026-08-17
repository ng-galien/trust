import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../../lib/format.js";
import { useResolvedTheme } from "../../lib/preferences.js";

/* Mermaid diagrams (flow, sequence, state…) rendered in the page with the interface tokens.
   The library loads on first use (its own chunk); a diagram re-renders when the theme changes. */

let counter = 0;

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function renderMermaid(code: string, dark: boolean): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  const text = token("--color-text");
  const muted = token("--color-text-muted");
  const surface = token("--color-surface");
  const surface2 = token("--color-surface-2");
  const surface3 = token("--color-surface-3");
  const border = token("--color-border-strong");
  const accent = token("--color-accent");
  const accentSoft = token("--color-accent-soft");
  const success = token("--color-success");
  const warning = token("--color-warning");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: token("--font-sans"),
    themeVariables: {
      darkMode: dark,
      background: surface,
      fontSize: "13px",
      primaryColor: accentSoft,
      primaryTextColor: text,
      primaryBorderColor: accent,
      secondaryColor: surface2,
      secondaryTextColor: text,
      secondaryBorderColor: border,
      tertiaryColor: surface3,
      tertiaryTextColor: text,
      tertiaryBorderColor: border,
      lineColor: muted,
      textColor: text,
      mainBkg: surface2,
      nodeBorder: border,
      clusterBkg: surface,
      clusterBorder: border,
      titleColor: text,
      edgeLabelBackground: surface,
      // sequence diagrams
      actorBkg: accentSoft,
      actorBorder: accent,
      actorTextColor: text,
      actorLineColor: border,
      signalColor: text,
      signalTextColor: text,
      labelBoxBkgColor: surface3,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: surface3,
      noteBorderColor: border,
      noteTextColor: text,
      activationBkgColor: surface3,
      activationBorderColor: accent,
      sequenceNumberColor: surface,
      // state diagrams
      labelColor: text,
      altBackground: surface2,
      // misc
      pie1: accent, pie2: success, pie3: warning,
    },
    flowchart: { curve: "basis", padding: 12, htmlLabels: true, nodeSpacing: 40, rankSpacing: 48 },
    sequence: { actorMargin: 40, messageMargin: 32, mirrorActors: false, boxMargin: 8, useMaxWidth: true, wrap: true, width: 150 },
  });
  counter += 1;
  const { svg } = await mermaid.render(`docs-diagram-${counter}`, code);
  return svg;
}

export function Diagram({ code, caption, className }: { code: string; caption?: string; className?: string }) {
  const { t } = useTranslation();
  const theme = useResolvedTheme();
  const id = useId();
  const [state, setState] = useState<{ svg?: string; error?: string }>({});

  useEffect(() => {
    let cancelled = false;
    setState({});
    renderMermaid(code.trim(), theme === "dark")
      .then((svg) => { if (!cancelled) setState({ svg }); })
      .catch((error: unknown) => { if (!cancelled) setState({ error: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; };
  }, [code, theme]);

  return (
    <figure className={cx("docs-diagram my-5", className)} id={id}>
      <div className="overflow-x-auto rounded-(--radius-3) border border-border bg-surface p-3">
        {state.svg ? <div className="docs-diagram-svg mx-auto [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: state.svg }} /> : null}
        {state.error ? <p className="text-body text-danger">{t("docs.diagram.error", { error: state.error })}</p> : null}
        {!state.svg && !state.error ? <p className="py-6 text-center text-body text-faint">{t("docs.diagram.loading")}</p> : null}
      </div>
      {caption ? <figcaption className="mt-2 text-center text-body-lg text-muted">{caption}</figcaption> : null}
    </figure>
  );
}
