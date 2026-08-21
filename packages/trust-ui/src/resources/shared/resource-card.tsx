import type { ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "../../lib/format.js";
import { InfoBadge } from "../../ui/info-popover.js";

/* One card, one resource: marks + version on top, human title (with ⓘ when described), id,
   a small facts list, and a footer anchored at the bottom. */

export function ResourceCard({
  to,
  marks,
  version,
  title,
  description,
  id,
  note,
  facts,
  footerLeft,
  footerRight,
  className,
}: {
  to: string;
  marks: ReactNode;
  version?: string | undefined;
  title: string;
  description?: string | undefined;
  id: string;
  /** e.g. the search match reason */
  note?: ReactNode;
  facts: Array<{ label: string; value: ReactNode }>;
  footerLeft: ReactNode;
  footerRight: ReactNode;
  className?: string;
}) {
  return (
    <Link to={to} data-doc="home.card" className={cx("card-link min-w-0 flex flex-col rounded-(--radius-3) border border-border bg-surface transition-[border-color,box-shadow]", className)}>
      <div className="flex items-center gap-1.5 px-4 pt-3.5">
        {marks}
        {version ? <span className="mono ml-auto text-caption text-faint">v{version}</span> : null}
      </div>
      <div className="px-4 pt-2.5 pb-3">
        <div className="flex items-start gap-1.5">
          <h3 className="clamp-2 min-w-0 flex-1 text-subhead leading-snug font-semibold">{title}</h3>
          {description ? <InfoBadge title={title} className="mt-0.5 shrink-0">{description}</InfoBadge> : null}
        </div>
        <p className="mono mt-1 truncate-1 text-label text-muted">{id}</p>
        {note ? <p className="mt-1 text-caption text-accent">{note}</p> : null}
      </div>
      {facts.length ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border px-4 py-2.5 text-body leading-snug">
          {facts.map((fact) => (
            <FactRow key={fact.label} label={fact.label} value={fact.value} />
          ))}
        </dl>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-label text-muted">
        {footerLeft}
        {footerRight}
      </div>
    </Link>
  );
}

function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 overflow-hidden break-words">{value}</dd>
    </>
  );
}

export function CardGrid({ children, min = 300 }: { children: ReactNode; min?: number }) {
  return <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>{children}</div>;
}

/** Mono list of names, truncated with +n. */
export function NameList({ names, max = 3 }: { names: string[]; max?: number }) {
  if (names.length === 0) return <span className="text-faint">—</span>;
  const shown = names.slice(0, max);
  return (
    <span className="mono">
      {shown.join(", ")}
      {names.length > max ? <span className="font-sans text-faint"> +{names.length - max}</span> : null}
    </span>
  );
}
