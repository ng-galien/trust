import { Children, isValidElement, useEffect, useId, useState } from "react";
import ReactMarkdown from "react-markdown";

export function Markdown({ source, language }: { source: string; language: string }) {
  return (
    <div className="coordination-markdown">
      <ReactMarkdown
        skipHtml
        disallowedElements={["img"]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          pre: ({ children }) => {
            const child = Children.toArray(children)[0];
            if (
              isValidElement<{ className?: string; children?: unknown }>(child) &&
              child.props.className === "language-mermaid"
            ) {
              return <Mermaid source={String(child.props.children ?? "").trim()} language={language} />;
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function Mermaid({ source, language }: { source: string; language: string }) {
  const id = `coordination-diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setSvg("");
    setFailed(false);
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "neutral",
          flowchart: { htmlLabels: false },
        });
        const result = await mermaid.render(id, source);
        if (active) setSvg(result.svg);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [id, source]);
  if (failed)
    return (
      <div className="coordination-diagram-error">
        <p>{language.startsWith("fr") ? "Diagramme indisponible — source" : "Diagram unavailable — source"}</p>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  return (
    <div
      className="coordination-diagram"
      role="img"
      aria-label={language.startsWith("fr") ? "Diagramme Mermaid" : "Mermaid diagram"}
      aria-busy={!svg}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Only strict-mode mermaid.render output is inserted; Mermaid applies DOMPurify before returning SVG. Raw Markdown HTML is disabled above.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
