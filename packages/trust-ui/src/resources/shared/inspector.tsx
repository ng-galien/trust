import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "../../lib/format.js";
import { useOrigin } from "./origin.js";

/* Right-hand context of an item overlay: relations first, then contract facts. */

export function InspectorSection({ title, count, children, className }: { title: string; count?: number; children: ReactNode; className?: string }) {
  return (
    <section className={cx("border-b border-border px-4 py-3 last:border-b-0", className)}>
      <h3 className="kicker mb-2 flex items-center gap-2">
        {title}
        {count !== undefined ? <span className="text-faint normal-case tracking-normal">{count}</span> : null}
      </h3>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

export function RelationLink({ to, icon, title, meta, state }: { to: string; icon: ReactNode; title: string; meta?: string; state?: ReactNode }) {
  const origin = useOrigin();
  return (
    <Link to={to} state={origin} className="flex items-center gap-2 rounded-(--radius-1) px-1.5 py-1 hover:bg-surface-2">
      <span className="shrink-0 text-muted [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="mono truncate-1 block text-body font-medium">{title}</span>
        {meta ? <span className="block truncate-1 text-caption text-muted">{meta}</span> : null}
      </span>
      {state}
      <ChevronRight size={12} className="shrink-0 text-faint" />
    </Link>
  );
}

export function EmptyRelation({ children }: { children: ReactNode }) {
  return <p className="text-body text-faint">{children}</p>;
}
