import { AlertTriangle, ArrowRight, BookMarked, ChevronRight, Info, Lightbulb, Scale } from "lucide-react";
import type { ParseKeys } from "i18next";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";

import type { Language } from "../../i18n/index.js";
import { cx } from "../../lib/format.js";
import { useExpert, usePreference } from "../../lib/preferences.js";
import { useDismiss } from "../../lib/use-dismiss.js";
import { Badge } from "../../ui/badge.js";
import { findNode } from "../pages.js";
import { VisualDialog, VisualExpandButton } from "./visual-dialog.js";

/* Building blocks available inside every documentation page (mapped through MDXProvider). */

/** Aside block: note, tip, warning, or a product rule (something TRUST guarantees or refuses). */
export function Callout({ kind = "note", title, children }: { kind?: "note" | "tip" | "warning" | "rule"; title?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  const Icon = kind === "tip" ? Lightbulb : kind === "warning" ? AlertTriangle : kind === "rule" ? Scale : Info;
  const tone = kind === "tip" ? "border-success/40 bg-success-soft/40" : kind === "warning" ? "border-warning/40 bg-warning-soft/50" : kind === "rule" ? "border-accent/40 bg-accent-soft/50" : "border-border bg-surface-2";
  const iconTone = kind === "tip" ? "text-success" : kind === "warning" ? "text-warning" : kind === "rule" ? "text-accent" : "text-muted";
  return (
    <aside className={cx("docs-callout my-4 flex gap-3 rounded-(--radius-3) border px-4 py-3", tone)} data-kind={kind}>
      <Icon size={16} className={cx("mt-0.5 shrink-0", iconTone)} />
      <div className="min-w-0 flex-1 text-ui leading-relaxed">
        <div className="mb-0.5 text-caption font-semibold uppercase tracking-[0.06em] text-muted">{title ?? t(`docs.callout.${kind}`)}</div>
        <div className="docs-callout-body">{children}</div>
      </div>
    </aside>
  );
}

/** Collapsible section. `expert` marks detail the operator does not need: closed by default, open in expert mode. */
export function Details({ title, expert = false, open: openByDefault, children }: { title: ReactNode; expert?: boolean; open?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const isExpert = useExpert();
  const [open, setOpen] = useState(openByDefault ?? (expert ? isExpert : false));
  return (
    <section className="docs-details my-3 rounded-(--radius-2) border border-border bg-surface">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui font-semibold hover:bg-surface-2">
        <ChevronRight size={14} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1">{title}</span>
        {expert ? <span title={t("docs.details.expertHint")}><Badge tone="info">{t("docs.details.expert")}</Badge></span> : null}
      </button>
      {open ? <div className="docs-details-body border-t border-border px-4 py-3">{children}</div> : null}
    </section>
  );
}

type GlossaryId = "agent" | "tool" | "operator" | "operation" | "check" | "scenario" | "procedure" | "plan" | "session" | "attempt" | "fact" | "verdict" | "qualification" | "cascade" | "environment" | "credential" | "runner" | "skill" | "delegation" | "dryRun" | "snapshot" | "revision" | "intent" | "escalation" | "otlp" | "mcp" | "jsonata" | "grant";

/** Glossary term: the word stays in the sentence; a click opens its definition in place (inline elements only —
    a term lives inside a paragraph). */
export function Term({ id, children }: { id: GlossaryId; children?: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, root, close);
  const term = t(`docs.glossary.${id}.term` as ParseKeys);
  const definition = t(`docs.glossary.${id}.definition` as ParseKeys);
  return (
    <span ref={root} className="relative inline">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className={cx("docs-term rounded-[3px] border-b border-dotted border-accent/60 text-inherit hover:bg-accent-soft", open && "bg-accent-soft")}>
        {children ?? term}
      </button>
      {open ? (
        <span role="dialog" className="absolute top-full left-0 z-50 mt-1 block w-[24rem] max-w-[80vw] rounded-(--radius-2) border border-border bg-surface p-3 text-left font-normal shadow-(--shadow-2)">
          <span className="mb-1 flex items-center gap-2 text-body-lg font-semibold"><BookMarked size={13} className="text-accent" /> {term}</span>
          <span className="block text-body-lg leading-relaxed">{definition}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Cards of the sub-pages of the current (or given) page — the hub pattern: one screen, then deeper. */
export function PageCards({ of }: { of?: string }) {
  const { t } = useTranslation();
  const language = usePreference("language") as Language;
  const location = useLocation();
  const currentPath = location.pathname.replace(/^\/docs\/?/, "").replace(/\/+$/, "");
  const path = of ?? currentPath;
  const node = findNode(path, language);
  if (!node || node.children.length === 0) return null;
  return (
    <nav aria-label={t("docs.nav.inThisSection")} className="docs-cards my-5 grid gap-3 sm:grid-cols-2">
      {node.children.map((child) => (
        <Link key={child.page.path} to={`/docs/${child.page.path}`} className="group flex flex-col gap-1 rounded-(--radius-3) border border-border bg-surface p-4 hover:border-border-strong hover:bg-surface-2">
          <span className="flex items-center gap-2 text-ui font-semibold">
            {child.page.title}
            {child.page.draft ? <Badge>Draft</Badge> : null}
            <ArrowRight size={14} className="ml-auto text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
          </span>
          {child.page.summary ? <span className="text-body-lg leading-relaxed text-muted">{child.page.summary}</span> : null}
          {child.children.length ? <span className="mt-1 text-caption text-faint">{child.children.map((grandChild) => grandChild.page.title).join(" · ")}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** Figure with a caption; wraps a hero SVG component, a diagram or an image. */
export function Figure({ caption, children, wide = false }: { caption?: ReactNode; children: ReactNode; wide?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <figure className={cx("docs-figure my-5", wide && "docs-wide")}>
      <div className="group/visual relative overflow-x-auto rounded-(--radius-3) border border-border bg-surface p-4">
        <VisualExpandButton onClick={() => setExpanded(true)} />
        {children}
      </div>
      {caption ? <figcaption className="mt-2 text-center text-body-lg text-muted">{caption}</figcaption> : null}
      <VisualDialog open={expanded} onClose={() => setExpanded(false)} label={t("docs.visual.figure")}>
        <div className="[&_svg]:!h-auto [&_svg]:!max-h-[86vh] [&_svg]:!w-[92vw] [&_svg]:!max-w-none">{children}</div>
      </VisualDialog>
    </figure>
  );
}

/** Numbered legend under a screenshot or an annotated snippet: ① text, ② text… */
export function Legend({ items }: { items: ReactNode[] }) {
  return (
    <ol className="docs-legend my-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2 text-ui leading-relaxed">
          <span className="docs-mark">{index + 1}</span>
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ol>
  );
}

/** Ordered steps of a guide, each with a title and a body. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="docs-steps my-4 flex flex-col gap-4">{children}</ol>;
}

export function Step({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <li className="docs-step relative pl-9">
      <span className="docs-step-number" aria-hidden />
      <div className="text-ui font-semibold">{title}</div>
      {children ? <div className="docs-step-body mt-1 text-ui leading-relaxed">{children}</div> : null}
    </li>
  );
}

/** Two-column comparison (operator vs expert, live vs dry-run…). */
export function Compare({ left, right, leftTitle, rightTitle }: { left: ReactNode; right: ReactNode; leftTitle: ReactNode; rightTitle: ReactNode }) {
  return (
    <div className="docs-compare my-4 grid gap-3 sm:grid-cols-2">
      {[[leftTitle, left], [rightTitle, right]].map(([title, body], index) => (
        <div key={index} className="rounded-(--radius-3) border border-border bg-surface p-4">
          <div className="mb-2 text-caption font-semibold uppercase tracking-[0.06em] text-muted">{title}</div>
          <div className="docs-compare-body text-ui leading-relaxed">{body}</div>
        </div>
      ))}
    </div>
  );
}
