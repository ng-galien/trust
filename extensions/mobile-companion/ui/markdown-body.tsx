import { Children, cloneElement, isValidElement, type ReactNode, type Ref } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./mermaid-diagram";

const allowedElements = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

function safeLinkUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    if (value.startsWith("/mobile/") && !value.startsWith("//")) {
      const url = new URL(value, window.location.origin);
      if (url.origin === window.location.origin && url.pathname.startsWith("/mobile/"))
        return `${url.pathname}${url.search}${url.hash}`;
    }
    if (value.startsWith("https://")) {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    }
  } catch {
    return "";
  }
  return "";
}

function visibleText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? visibleText(node.props.children) : "";
}

function removeRepeatedTitle(source: string, title: string): string {
  const opening = /^\s*#\s+([^\n]+)\n(?:\s*\n)*/.exec(source);
  if (!opening) return source;
  const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return normalized(opening[1] ?? "") === normalized(title) ? source.slice(opening[0].length) : source;
}

function tablePresentation(children: ReactNode): { content: ReactNode; compact: ReactNode | null } {
  const sections = Children.toArray(children);
  const head = sections.find((section) => isValidElement(section) && section.type === "thead");
  if (!isValidElement<{ children?: ReactNode }>(head)) return { content: children, compact: null };
  const row = Children.toArray(head.props.children)[0];
  if (!isValidElement<{ children?: ReactNode }>(row)) return { content: children, compact: null };
  const labels = Children.toArray(row.props.children).map((cell) =>
    isValidElement<{ children?: ReactNode }>(cell) ? visibleText(cell.props.children).trim() : "",
  );
  let compactRows: ReactNode[] = [];
  const content = sections.map((section) => {
    if (!isValidElement<{ children?: ReactNode }>(section) || section.type !== "tbody") return section;
    const grouped: { row: ReactNode; cells: ReactNode[] }[] = [];
    for (const bodyRow of Children.toArray(section.props.children)) {
      if (!isValidElement<{ children?: ReactNode }>(bodyRow) || bodyRow.type !== "tr") continue;
      const cells = Children.toArray(bodyRow.props.children);
      const lastCell = cells.at(-1);
      const continuation =
        grouped.length > 0 &&
        cells.length === labels.length &&
        cells
          .slice(0, -1)
          .every((cell) => isValidElement<{ children?: ReactNode }>(cell) && !visibleText(cell.props.children).trim());
      if (continuation && isValidElement<{ children?: ReactNode }>(lastCell)) {
        const previous = grouped.at(-1)!;
        const previousLast = previous.cells.at(-1);
        if (isValidElement<{ children?: ReactNode }>(previousLast)) {
          previous.cells[previous.cells.length - 1] = cloneElement(
            previousLast,
            {},
            <>
              {previousLast.props.children}
              <div className="mobile-table-continuation">{lastCell.props.children}</div>
            </>,
          );
          continue;
        }
      }
      grouped.push({ row: bodyRow, cells });
    }
    if (labels.length >= 4)
      compactRows = grouped.map(({ row: bodyRow, cells }) => (
        <details className="mobile-table-compact-row" key={isValidElement(bodyRow) ? bodyRow.key : visibleText(cells)}>
          <summary>
            <strong>{isValidElement<{ children?: ReactNode }>(cells[0]) ? cells[0].props.children : null}</strong>
            <span>{isValidElement<{ children?: ReactNode }>(cells[1]) ? cells[1].props.children : null}</span>
          </summary>
          <dl>
            {cells.slice(2).map((cell, cellIndex) => (
              <div key={labels[cellIndex + 2]}>
                <dt>{labels[cellIndex + 2]}</dt>
                <dd>{isValidElement<{ children?: ReactNode }>(cell) ? cell.props.children : null}</dd>
              </div>
            ))}
          </dl>
        </details>
      ));
    return cloneElement(
      section,
      {},
      grouped.map(({ row: bodyRow, cells }) => {
        if (!isValidElement<{ children?: ReactNode }>(bodyRow)) return bodyRow;
        return cloneElement(
          bodyRow,
          {},
          cells.map((cell, index) =>
            isValidElement<{ children?: ReactNode; "data-label"?: string }>(cell) && cell.type === "td"
              ? cloneElement(cell, { "data-label": labels[index] ?? "" })
              : cell,
          ),
        );
      }),
    );
  });
  return { content, compact: compactRows.length ? compactRows : null };
}

export function MarkdownBody({
  source,
  locale,
  title,
  sectionPrefix,
  bodyRef,
}: {
  source: string;
  locale: string;
  title: string;
  sectionPrefix: string;
  bodyRef?: Ref<HTMLDivElement>;
}) {
  const headingId = (offset: number | undefined) =>
    offset === undefined ? undefined : `mobile-section-${sectionPrefix}-${offset}`;
  return (
    <div className="mobile-body" ref={bodyRef}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        allowedElements={allowedElements}
        urlTransform={safeLinkUrl}
        components={{
          h1: ({ children, node }) => <h2 id={headingId(node?.position?.start.offset)}>{children}</h2>,
          h2: ({ children, node }) => <h3 id={headingId(node?.position?.start.offset)}>{children}</h3>,
          h3: ({ children, node }) => <h4 id={headingId(node?.position?.start.offset)}>{children}</h4>,
          h4: ({ children, node }) => <h5 id={headingId(node?.position?.start.offset)}>{children}</h5>,
          h5: ({ children, node }) => <h6 id={headingId(node?.position?.start.offset)}>{children}</h6>,
          h6: ({ children, node }) => <h6 id={headingId(node?.position?.start.offset)}>{children}</h6>,
          a: ({ href, children }) => {
            const safe = safeLinkUrl(href);
            return safe ? (
              <a href={safe} target={safe.startsWith("https://") ? "_blank" : undefined} rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          blockquote: ({ children }) => (
            <blockquote
              className={
                visibleText(children).includes("Revue indépendante — portée du modèle proposé")
                  ? "mobile-independent-review"
                  : undefined
              }
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => {
            const presentation = tablePresentation(children);
            const comparative = presentation.compact !== null;
            return (
              <section
                className="mobile-table-scroll"
                lang={locale}
                aria-label={locale.startsWith("fr") ? "Tableau comparatif" : "Comparison table"}
              >
                <div className="mobile-table-caption">
                  <span>{locale.startsWith("fr") ? "Tableau" : "Table"}</span>
                  <span>{locale.startsWith("fr") ? "Comparer les éléments" : "Compare entries"}</span>
                </div>
                {comparative && <div className="mobile-table-compact">{presentation.compact}</div>}
                <div className={comparative ? "mobile-table-desktop" : undefined}>
                  <section
                    className="mobile-table-viewport"
                    aria-label={locale.startsWith("fr") ? "Tableau" : "Table"}
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region needs keyboard access.
                    tabIndex={0}
                  >
                    <table>{presentation.content}</table>
                  </section>
                </div>
                {comparative && (
                  <details className="mobile-table-full">
                    <summary>
                      {locale.startsWith("fr")
                        ? "Voir le tableau complet · balayer pour comparer →"
                        : "View full table · swipe to compare →"}
                    </summary>
                    <section
                      className="mobile-table-viewport"
                      aria-label={locale.startsWith("fr") ? "Tableau" : "Table"}
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region needs keyboard access.
                      tabIndex={0}
                    >
                      <table>{presentation.content}</table>
                    </section>
                  </details>
                )}
              </section>
            );
          },
          pre: ({ children }) => {
            const code = Children.toArray(children)[0];
            if (
              isValidElement<{ className?: string; children?: unknown }>(code) &&
              code.props.className === "language-mermaid"
            )
              return <MermaidDiagram source={String(code.props.children ?? "").trim()} locale={locale} />;
            return <pre>{children}</pre>;
          },
        }}
      >
        {removeRepeatedTitle(source, title)}
      </Markdown>
    </div>
  );
}
