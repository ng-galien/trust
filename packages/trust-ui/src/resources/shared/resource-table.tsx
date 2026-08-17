import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { cx } from "../../lib/format.js";
import { InfoBadge } from "../../ui/info-popover.js";

/* Dense table projection shared by every resource: sticky header, full-bleed, row = link. */

export interface Column { key: string; label: string; width?: string }

export function ResourceTable<Row>({ columns, rows, rowKey, renderCells, className, stickyHeader = true }: { columns: Column[]; rows: Row[]; rowKey: (row: Row) => string; renderCells: (row: Row) => ReactNode[]; className?: string; /** Off when the table sits inside a scrolling page section rather than filling the scroll area. */ stickyHeader?: boolean }) {
  return (
    <div className={cx("bg-surface", className)}>
      <table className="w-full border-separate border-spacing-0 text-left text-body-lg">
        <thead className={cx("bg-surface", stickyHeader && "sticky top-0 z-10")}>
          <tr className="text-caption uppercase tracking-[0.06em] text-muted">
            {columns.map((column, index) => (
              <th key={column.key} className={cx("border-b border-border py-2 font-semibold", index === 0 ? "px-4" : "px-3")} style={column.width ? { width: column.width } : undefined}>{column.label}</th>
            ))}
            <th className="w-8 border-b border-border px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="row-link [&>td]:border-b [&>td]:border-border">
              {renderCells(row).map((cell, index) => (
                <td key={columns[index]?.key ?? index} className={cx("py-2 align-top", index === 0 ? "px-4" : "px-3")}>{cell}</td>
              ))}
              <td className="px-2 py-2 align-top text-faint"><ChevronRight size={14} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** First cell of a resource row: title, id · version, optional match note and ⓘ description. */
export function TitleCell({ to, title, id, version, description, note }: { to: string; title: string; id: string; version?: string | undefined; description?: string | undefined; note?: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5">
      <Link to={to} className="block min-w-0 leading-tight">
        <span className="block text-ui font-semibold">{title}</span>
        <span className="mono block text-caption text-muted">{id}{version ? <span className="text-faint"> · v{version}</span> : null}</span>
        {note ? <span className="block text-caption text-accent">{note}</span> : null}
      </Link>
      {description ? <InfoBadge title={title} className="mt-0.5 shrink-0">{description}</InfoBadge> : null}
    </div>
  );
}
