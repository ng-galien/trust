import { Check, Copy, ExternalLink } from "lucide-react";
import { Children, isValidElement, type ReactElement, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { cx } from "../../lib/format.js";
import { highlight } from "../highlight.js";
import { standalone } from "../standalone.js";
import { Diagram } from "./diagram.js";

/* Code snippet of the documentation: statically coloured, copyable, optionally linked to the catalog
   object it shows. Fence meta (```gherkin operation title="…" lines="3-5" marks="2,7"):
   - `operation` / `procedure`: a complete source — the acceptance test compiles it; with `id="git.head-read"`
     the snippet links to that catalog item;
   - `fragment`: an excerpt, not compilable on its own;
   - `title="…"`: caption; `lines="3-5,9"`: highlighted lines; `marks="2,7,12"`: numbered callouts ①②③ on lines. */

export interface SnippetMeta {
  kind?: "operation" | "procedure" | "fragment";
  id?: string;
  title?: string;
  lines?: number[];
  marks?: number[];
  numbers?: boolean;
}

export function parseMeta(meta: string | undefined): SnippetMeta {
  const out: SnippetMeta = {};
  if (!meta) return out;
  for (const match of meta.matchAll(/(\w+)(?:="([^"]*)")?/g)) {
    const [, key, value] = match;
    if (key === "operation" || key === "procedure" || key === "fragment") out.kind = key;
    else if (key === "id" && value) out.id = value;
    else if (key === "title" && value) out.title = value;
    else if (key === "lines" && value) out.lines = parseRanges(value);
    else if (key === "marks" && value) out.marks = parseRanges(value);
    else if (key === "numbers") out.numbers = true;
  }
  return out;
}

function parseRanges(value: string): number[] {
  const out: number[] = [];
  for (const part of value.split(",")) {
    const [start, end] = part.split("-").map((n) => Number.parseInt(n.trim(), 10));
    if (start === undefined || Number.isNaN(start)) continue;
    for (let line = start; line <= (end ?? start); line += 1) out.push(line);
  }
  return out;
}

export function Snippet({ code, language = "text", meta = {}, className }: { code: string; language?: string; meta?: SnippetMeta; className?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const lines = highlight(code, language, meta.kind);
  const marks = new Map((meta.marks ?? []).map((line, index) => [line, index + 1]));
  const highlighted = new Set(meta.lines ?? []);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
  };
  const link = meta.id && !standalone ? (meta.kind === "procedure" ? `/procedures/${encodeURIComponent(meta.id)}?tab=source` : `/operations/${encodeURIComponent(meta.id)}?tab=source`) : undefined;
  return (
    <figure className={cx("docs-snippet my-4 overflow-hidden rounded-(--radius-3) border border-border bg-surface", className)}>
      {(meta.title || link) ? (
        <figcaption className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-caption text-muted">
          <span className="mono truncate-1">{meta.title ?? meta.id}</span>
          {meta.kind === "fragment" ? <span className="rounded-(--radius-1) bg-surface-3 px-1 text-micro uppercase tracking-wide">{t("docs.snippet.fragment")}</span> : null}
          <span className="ml-auto" />
          {link ? <Link to={link} className="inline-flex items-center gap-1 text-accent hover:underline"><ExternalLink size={11} /> {meta.kind === "procedure" ? t("docs.snippet.openProcedure") : t("docs.snippet.openOperation")}</Link> : null}
        </figcaption>
      ) : null}
      <div className="relative">
        <button type="button" onClick={copy} className="absolute top-1.5 right-1.5 z-10 inline-flex h-6 items-center gap-1 rounded-(--radius-1) border border-border bg-surface px-1.5 text-caption text-muted opacity-0 transition-opacity hover:text-text focus-visible:opacity-100 [figure:hover_&]:opacity-100" aria-label={t("docs.snippet.copy")}>
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? t("docs.snippet.copied") : t("docs.snippet.copy")}
        </button>
        <pre className="mono overflow-x-auto p-3 text-body leading-[1.55]" data-language={language}>
          <code>
            {lines.map((tokens, index) => {
              const number = index + 1;
              const mark = marks.get(number);
              return (
                <span key={number} className={cx("docs-line", highlighted.has(number) && "docs-line-highlight", mark !== undefined && "docs-line-marked")}>
                  {marks.size ? <span className="docs-line-mark" aria-label={mark !== undefined ? t("docs.screenshot.callout", { n: String(mark) }) : undefined}>{mark ?? ""}</span> : null}
                  {meta.numbers ? <span className="docs-line-number">{number}</span> : null}
                  {tokens.map((token, at) => (token.cls ? <span key={at} className={`tk-${token.cls}`}>{token.text}</span> : token.text))}
                  {"\n"}
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </figure>
  );
}

/** MDX `pre` mapping: turns a fenced block into a Snippet (language and meta come from the `code` child). */
export function MdxPre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children).find((node): node is ReactElement<{ className?: string; meta?: string; children?: ReactNode }> => isValidElement(node));
  const props = child?.props ?? {};
  const language = /language-([\w-]+)/.exec(props.className ?? "")?.[1] ?? "text";
  const code = typeof props.children === "string" ? props.children : Children.toArray(props.children).join("");
  const meta = parseMeta(props.meta);
  // ```mermaid fences are diagrams, not code.
  if (language === "mermaid") return <Diagram code={code} {...(meta.title ? { caption: meta.title } : {})} />;
  return <Snippet code={code} language={language} meta={meta} />;
}
