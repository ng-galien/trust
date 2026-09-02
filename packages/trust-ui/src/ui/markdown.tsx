import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";

import { cx } from "../lib/format.js";

/** Safe CommonMark prose. Raw HTML stays text; agent-authored content is never injected into the DOM. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx("min-w-0 space-y-2 break-words text-body-lg leading-relaxed", className)}>
      <ReactMarkdown
        disallowedElements={["img"]}
        components={{
          a: ({ children: label, node: _node, ...props }) => <a {...props} className="text-accent underline underline-offset-2" rel="noreferrer" target="_blank">{label}</a>,
          blockquote: ({ children: quote }) => <blockquote className="border-l-2 border-border pl-3 text-muted">{quote}</blockquote>,
          code: ({ children: code, className: codeClassName }) => codeClassName
            ? <code className={cx("mono text-caption", codeClassName)}>{code}</code>
            : <code className="mono rounded-(--radius-1) bg-surface-3 px-1 py-0.5 text-caption">{code}</code>,
          h1: compactHeading,
          h2: compactHeading,
          h3: compactHeading,
          h4: compactHeading,
          ol: ({ children: items }) => <ol className="list-decimal space-y-1 pl-5">{items}</ol>,
          pre: ({ children: code }) => <pre className="overflow-x-auto rounded-(--radius-2) border border-border bg-surface-3 p-3">{code}</pre>,
          ul: ({ children: items }) => <ul className="list-disc space-y-1 pl-5">{items}</ul>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function compactHeading({ children }: { children?: ReactNode }) {
  return <h3 className="text-ui font-semibold text-text">{children}</h3>;
}
