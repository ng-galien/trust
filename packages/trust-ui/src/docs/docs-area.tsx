import { MDXProvider } from "@mdx-js/react";
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, ExternalLink, Languages, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { type AnchorHTMLAttributes, type ComponentProps, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation, useNavigate, useParams } from "react-router";

import type { Language } from "../i18n/index.js";
import { cx } from "../lib/format.js";
import { updatePreferences, usePreference } from "../lib/preferences.js";
import { Badge } from "../ui/badge.js";
import { Breadcrumb } from "../ui/breadcrumb.js";
import { IconButton } from "../ui/button.js";
import { EmptyState } from "../ui/states.js";
import { Callout, Compare, Details, Figure, Legend, PageCards, Step, Steps, Term } from "./components/blocks.js";
import { Diagram } from "./components/diagram.js";
import { OperationLanguageReference, ProcedureLanguageReference } from "./components/language-reference.js";
import { Screenshot } from "./components/screenshot.js";
import { MdxPre, Snippet } from "./components/snippet.js";
import { ArchitectureFigure, ModelFigure } from "./figures/index.js";
import { type DocsNode, type DocsPage, findNode, findPage, pageSequence, pageTree, searchPages } from "./pages.js";
import { standalone } from "./standalone.js";

/* The documentation area: contents tree · article · "on this page". Pages are MDX under `content/`;
   the URL is `/docs/<path>` whatever the language (the language only chooses the translation). */

export function DocsArea() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams();
  const language = usePreference("language") as Language;
  const navOpen = usePreference("docsNavOpen");
  const path = (params["*"] ?? "").replace(/\/+$/, "");
  const found = findPage(path, language);
  const sequence = useMemo(() => pageSequence(language), [language]);
  const index = found ? sequence.findIndex((page) => page.path === found.page.path) : -1;
  const previous = index > 0 ? sequence[index - 1] : undefined;
  const next = index >= 0 ? sequence[index + 1] : undefined;
  const article = useRef<HTMLElement>(null);
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // The former Principles hub was merged into the documentation introduction.
  useEffect(() => {
    if (path === "principles") navigate({ pathname: "/docs", hash: location.hash }, { replace: true });
  }, [location.hash, navigate, path]);

  // A new page starts at the top (or at its hash anchor).
  useLayoutEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    else article.current?.scrollTo({ top: 0 });
  }, [path, location.hash]);

  useEffect(() => setMobileNavOpen(false), [path]);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-bg">
      {navOpen ? <ContentsTree language={language} current={path} className="hidden md:flex" /> : null}
      {mobileNavOpen ? (
        <div className="absolute inset-0 z-40 flex md:hidden">
          <ContentsTree language={language} current={path} className="relative z-10 w-[min(18rem,calc(100vw-3rem))] shadow-(--shadow-3)" onNavigate={() => setMobileNavOpen(false)} />
          <button type="button" aria-label={t("docs.nav.collapse")} className="absolute inset-0 bg-black/25 backdrop-blur-[1px]" onClick={() => setMobileNavOpen(false)} />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-2 sm:gap-3 sm:px-3">
          <span className="md:hidden">
            <IconButton label={mobileNavOpen ? t("docs.nav.collapse") : t("docs.nav.expand")} size="sm" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)}>
              {mobileNavOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </IconButton>
          </span>
          <span className="hidden md:inline-flex">
            <IconButton label={navOpen ? t("docs.nav.collapse") : t("docs.nav.expand")} size="sm" aria-expanded={navOpen} onClick={() => updatePreferences({ docsNavOpen: !navOpen })}>
              {navOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </IconButton>
          </span>
          <Breadcrumb items={[standalone ? { label: "TRUST" } : { label: "TRUST", to: "/overview" }, { label: t("docs.crumb"), to: "/docs" }, ...crumbsFor(path, language)]} className="hidden min-w-0 flex-1 sm:flex" />
          <DocsSearch language={language} />
        </div>
        <div className="flex min-h-0 flex-1">
          <article ref={article} className="docs-article min-w-0 flex-1 overflow-y-auto scroll-pt-6">
            {found ? (
              <div data-doc-page className="mx-auto w-full max-w-[52rem] px-5 pt-5 pb-16 sm:px-8 sm:pt-6 2xl:max-w-[68rem] 2xl:px-10">
                <PageHead page={found.page} fallback={found.fallback} />
                <MDXProvider components={mdxComponents}>
                  <found.page.Content />
                </MDXProvider>
                <footer className="mt-12 flex items-center justify-between gap-4 border-t border-border pt-4 text-ui">
                  {previous ? <Link to={`/docs/${previous.path}`} className="group flex min-w-0 items-center gap-2 text-muted hover:text-text"><ArrowLeft size={14} className="shrink-0 transition-transform group-hover:-translate-x-0.5" /><span className="min-w-0"><span className="block text-caption text-faint">{t("docs.nav.previous")}</span><span className="truncate-1 block font-medium">{previous.title}</span></span></Link> : <span />}
                  {next ? <Link to={`/docs/${next.path}`} className="group flex min-w-0 items-center gap-2 text-right text-muted hover:text-text"><span className="min-w-0"><span className="block text-caption text-faint">{t("docs.nav.next")}</span><span className="truncate-1 block font-medium">{next.title}</span></span><ArrowRight size={14} className="shrink-0 transition-transform group-hover:translate-x-0.5" /></Link> : <span />}
                </footer>
              </div>
            ) : (
              <div className="p-8"><EmptyState icon={<BookOpen />} title={t("docs.page.notFound")} action={<Link to="/docs" className="text-accent hover:underline">{t("docs.page.backHome")}</Link>} /></div>
            )}
          </article>
          {found ? <OnThisPage key={found.page.path + found.page.language} container={article} /> : null}
        </div>
      </div>
    </div>
  );
}

function crumbsFor(path: string, language: Language) {
  const crumbs: Array<{ label: string; to?: string }> = [];
  const parts = path ? path.split("/") : [];
  parts.forEach((_part, index) => {
    const partial = parts.slice(0, index + 1).join("/");
    const page = findPage(partial, language)?.page;
    if (page) crumbs.push({ label: page.title, to: `/docs/${partial}` });
  });
  return crumbs;
}

function PageHead({ page, fallback }: { page: DocsPage; fallback: boolean }) {
  const { t } = useTranslation();
  return (
    <header className="mb-6">
      <h1 className="text-heading font-semibold tracking-tight">{page.title}</h1>
      {page.summary ? <p className="mt-1 text-lead leading-relaxed text-muted">{page.summary}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">
        {page.screen && !standalone ? <Link to={page.screen} className="inline-flex items-center gap-1 rounded-(--radius-2) border border-border bg-surface px-2 py-0.5 text-caption text-accent hover:bg-surface-2"><ExternalLink size={11} /> {t("docs.page.openScreen")}</Link> : null}
        {fallback ? <span className="inline-flex items-center gap-1 text-caption text-muted"><Languages size={12} /> {t("docs.page.fallback")}</span> : null}
        {page.draft ? <Badge tone="warning">{t("docs.page.draft")}</Badge> : null}
      </div>
    </header>
  );
}

/* -------------------------------------------------------------- contents */

function ContentsTree({ language, current, className, onNavigate }: { language: Language; current: string; className?: string; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const tree = useMemo(() => pageTree(language), [language]);
  return (
    <nav aria-label={t("docs.nav.label")} onClick={(event) => { if ((event.target as Element).closest("a")) onNavigate?.(); }} className={cx("flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface px-2 py-3", className)}>
      <NavLink to="/docs" end className={({ isActive }) => cx("flex h-7 items-center gap-2 rounded-(--radius-2) px-2 text-ui hover:bg-surface-2", isActive ? "bg-surface-3 font-semibold" : "")}>
        <BookOpen size={14} className="text-muted" /> {t("docs.nav.home")}
      </NavLink>
      <div className="mt-2 flex flex-col gap-0.5">
        {tree.map((node) => <TreeNode key={node.page.path} node={node} current={current} depth={0} />)}
      </div>
    </nav>
  );
}

function TreeNode({ node, current, depth }: { node: DocsNode; current: string; depth: number }) {
  const inBranch = current === node.page.path || current.startsWith(`${node.page.path}/`);
  const [open, setOpen] = useState(inBranch);
  useEffect(() => { if (inBranch) setOpen(true); }, [inBranch]);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div className={cx("group/tree flex h-7 items-center rounded-(--radius-2) pr-1", current === node.page.path ? "bg-surface-3" : "hover:bg-surface-2")} style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-faint hover:text-text">
            <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
          </button>
        ) : <span className="w-5 shrink-0" />}
        <NavLink to={`/docs/${node.page.path}`} end className={cx("flex h-full min-w-0 flex-1 items-center gap-1.5 truncate-1 text-ui", current === node.page.path ? "font-semibold text-text" : depth === 0 ? "font-medium text-text" : "text-muted hover:text-text")}>
          <span className="truncate-1">{node.page.title}</span>
          {node.page.draft ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Draft" /> : null}
        </NavLink>
      </div>
      {open && hasChildren ? <div className="flex flex-col gap-0.5">{node.children.map((child) => <TreeNode key={child.page.path} node={child} current={current} depth={depth + 1} />)}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------- on this page */

function OnThisPage({ container }: { container: { current: HTMLElement | null } }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [headings, setHeadings] = useState<Array<{ id: string; text: string; level: number }>>([]);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id]"));
    setHeadings(nodes.map((node) => ({ id: node.id, text: Array.from(node.childNodes).filter((child) => !(child instanceof HTMLAnchorElement)).map((child) => child.textContent ?? "").join(""), level: node.tagName === "H2" ? 2 : 3 })));
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive((visible[0].target as HTMLElement).id);
    }, { root, rootMargin: "0px 0px -70% 0px" });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [container]);

  if (headings.length < 2) return <aside className="hidden w-52 shrink-0 xl:block" />;
  return (
    <aside className="hidden w-52 shrink-0 overflow-y-auto border-l border-border px-4 py-6 xl:block" aria-label={t("docs.nav.toc")}>
      <div className="kicker mb-2">{t("docs.nav.toc")}</div>
      <ul className="flex flex-col gap-1">
        {headings.map((heading) => (
          <li key={heading.id} className={heading.level === 3 ? "pl-3" : ""}>
            <Link to={{ pathname: location.pathname, search: location.search, hash: `#${heading.id}` }} className={cx("block truncate-1 border-l-2 py-0.5 pl-2 text-body-lg", active === heading.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>{heading.text}</Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/* --------------------------------------------------------------- search */

function DocsSearch({ language }: { language: Language }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchPages(query, language), [query, language]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const go = (page: DocsPage) => { navigate(`/docs/${page.path}`); setOpen(false); setQuery(""); };
  return (
    <div ref={root} className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
      <label className="relative flex items-center">
        <Search size={13} className="pointer-events-none absolute left-2.5 text-faint" />
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) go(results[0].page);
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder={t("docs.search.placeholder")}
          aria-label={t("docs.search.label")}
          className="h-7 w-full rounded-(--radius-2) border border-border bg-bg pl-7 pr-2 text-body-lg placeholder:text-faint focus:border-border-focus focus:bg-surface"
        />
      </label>
      {open && query.trim() ? (
        <div className="absolute top-full right-0 z-50 mt-1 w-[28rem] max-w-[80vw] rounded-(--radius-2) border border-border bg-surface p-1 shadow-(--shadow-2)">
          {results.length === 0 ? <p className="px-2 py-1.5 text-body text-faint">{t("docs.search.noResult")}</p> : null}
          {results.map(({ page, excerpt }) => (
            <button key={page.path} type="button" onClick={() => go(page)} className="flex w-full flex-col items-start gap-0.5 rounded-(--radius-1) px-2 py-1.5 text-left hover:bg-surface-2">
              <span className="text-body-lg font-medium">{page.title}</span>
              <span className="line-clamp-2 text-caption text-muted">{excerpt}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- MDX mapping */

function heading(level: 2 | 3 | 4) {
  const Tag = `h${level}` as const;
  return function Heading({ id, children, ...rest }: ComponentProps<"h2">) {
    const location = useLocation();
    return (
      <Tag id={id} {...rest} className={cx("group/h scroll-mt-4", rest.className)}>
        {children}
        {id ? <Link to={{ pathname: location.pathname, search: location.search, hash: `#${id}` }} className="ml-2 text-faint opacity-0 hover:text-accent group-hover/h:opacity-100" aria-hidden>#</Link> : null}
      </Tag>
    );
  };
}

function MdxLink({ href = "", children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const external = /^[a-z]+:/.test(href);
  if (external) return <a href={href} target="_blank" rel="noreferrer" {...rest}>{children} <ExternalLink size={11} className="inline align-baseline" /></a>;
  return <Link to={href} {...rest}>{children}</Link>;
}

const mdxComponents = {
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  a: MdxLink,
  pre: MdxPre,
  table: ({ children }: { children?: ReactNode }) => <div className="docs-table-wrap my-4 overflow-x-auto"><table>{children}</table></div>,
  Callout, Details, Term, PageCards, Figure, Legend, Steps, Step, Compare,
  Diagram, Screenshot, Snippet,
  OperationLanguageReference, ProcedureLanguageReference,
  ModelFigure, ArchitectureFigure,
};
