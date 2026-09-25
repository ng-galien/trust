import { useEffect, useId, useRef, useState } from "react";
import { useMobileUi } from "./store";

let renderQueue = Promise.resolve();

function queueRender(id: string, source: string, colors: Record<string, string>, dark: boolean): Promise<string> {
  const task = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 10000,
      maxEdges: 60,
      theme: "base",
      themeVariables: {
        darkMode: dark,
        background: colors.surface,
        primaryColor: colors.accentSoft,
        primaryTextColor: colors.text,
        primaryBorderColor: colors.accent,
        lineColor: colors.muted,
        textColor: colors.text,
        edgeLabelBackground: colors.surface,
        secondaryColor: colors.surface,
        secondaryTextColor: colors.text,
        tertiaryColor: colors.accentSoft,
        tertiaryTextColor: colors.text,
        nodeBorder: colors.line,
      },
      flowchart: { htmlLabels: false, useMaxWidth: false, padding: 12 },
    });
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
  renderQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export function MermaidDiagram({ source, locale }: { source: string; locale: string }) {
  const id = `mobile-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const theme = useMobileUi((state) => state.theme);
  const accent = useMobileUi((state) => state.accent);
  const figure = useRef<HTMLElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const french = locale.toLowerCase().startsWith("fr");

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      openButton.current?.focus();
    };
  }, [expanded]);

  // Accent changes alter the CSS variables read below even when source and theme are stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-render the diagram when its CSS palette changes.
  useEffect(() => {
    let active = true;
    setSvg("");
    setError(false);
    const element = figure.current;
    if (!element) return;
    const styles = getComputedStyle(element);
    const color = (name: string) => styles.getPropertyValue(name).trim();
    const colors = {
      surface: color("--surface"),
      text: color("--text"),
      accent: color("--accent"),
      accentSoft: color("--accent-soft"),
      line: color("--line"),
      muted: color("--muted"),
    };
    void queueRender(id, source, colors, theme === "dark")
      .then((next) => {
        if (active) setSvg(next);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [id, source, theme, accent]);

  const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return (
    <>
      <figure className="mobile-mermaid" ref={figure} data-expanded={expanded}>
        {svg ? (
          <>
            <div className="mobile-mermaid-toolbar">
              <span>{french ? "Vue d’ensemble du diagramme" : "Diagram overview"}</span>
              <button
                ref={openButton}
                type="button"
                aria-expanded={expanded}
                onClick={() => {
                  setZoomed(false);
                  setExpanded(true);
                }}
              >
                {french ? "Agrandir" : "Expand"}
              </button>
            </div>
            <section
              className="mobile-mermaid-scroll"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region needs keyboard access.
              tabIndex={0}
              aria-label={french ? "Parcourir le diagramme" : "Explore diagram"}
            >
              <img
                src={image}
                alt={french ? "Diagramme Mermaid" : "Mermaid diagram"}
                onError={() => {
                  setSvg("");
                  setError(true);
                }}
              />
            </section>
          </>
        ) : error ? (
          <div className="mobile-mermaid-error" role="status">
            <strong>
              {french ? "Diagramme indisponible : syntaxe invalide" : "Diagram unavailable: invalid syntax"}
            </strong>
            <pre>
              <code>{source}</code>
            </pre>
          </div>
        ) : (
          <p role="status">{french ? "Chargement du diagramme…" : "Loading diagram…"}</p>
        )}
        {svg && (
          <details>
            <summary>{french ? "Source du diagramme" : "Diagram source"}</summary>
            <pre>
              <code>{source}</code>
            </pre>
          </details>
        )}
      </figure>
      {expanded && svg && (
        <div className="mobile-mermaid-dialog-layer">
          <button
            type="button"
            className="mobile-mermaid-dialog-scrim"
            aria-label={french ? "Fermer le diagramme" : "Close diagram"}
            onClick={() => setExpanded(false)}
          />
          <div
            className="mobile-mermaid-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={french ? "Diagramme agrandi" : "Expanded diagram"}
            data-zoomed={zoomed}
          >
            <div className="mobile-mermaid-dialog-heading">
              <strong>{french ? "Diagramme" : "Diagram"}</strong>
              <button type="button" aria-pressed={zoomed} onClick={() => setZoomed((value) => !value)}>
                {zoomed ? (french ? "Vue d’ensemble" : "Overview") : french ? "Taille réelle" : "Actual size"}
              </button>
              <button ref={closeButton} type="button" onClick={() => setExpanded(false)}>
                {french ? "Fermer" : "Close"}
              </button>
            </div>
            <section
              aria-label={french ? "Diagramme agrandi" : "Expanded diagram"}
              className="mobile-mermaid-dialog-scroll"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region needs keyboard access.
              tabIndex={0}
              data-zoomed={zoomed}
            >
              <img src={image} alt={french ? "Diagramme Mermaid agrandi" : "Expanded Mermaid diagram"} />
            </section>
          </div>
        </div>
      )}
    </>
  );
}
