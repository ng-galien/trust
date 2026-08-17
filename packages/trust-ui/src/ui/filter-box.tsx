import { Check, ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../lib/format.js";
import { useDismiss } from "../lib/use-dismiss.js";

/* One field that merges free-text search and faceted filters:
   active facets are chips inside the field, a picker lists every category with counts. */

interface FacetOption {
  value: string;
  /** Display text (chips and picker). */
  label: string;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Omitted when the list is server-paginated (no honest per-option total). */
  count?: number;
}

export interface FacetGroupSpec {
  id: string;
  label: string;
  options: FacetOption[];
  selected: string[];
  /** Single-choice group (selecting replaces). */
  exclusive?: boolean;
  /** `clearQuery` is true when the value was reached by typing: apply both changes in one update. */
  onToggle: (value: string, options?: { clearQuery?: boolean }) => void;
}

export function FilterBox({
  query,
  onQuery,
  groups,
  placeholder,
  onClearAll,
  className,
}: {
  query: string;
  onQuery: (value: string) => void;
  groups: FacetGroupSpec[];
  placeholder: string;
  onClearAll: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const input = useRef<HTMLInputElement>(null);

  const chips = groups.flatMap((group) => group.selected.map((value) => ({ group, value, option: group.options.find((option) => option.value === value) })));
  const activeCount = chips.length + (query ? 1 : 0);

  useDismiss(open, root, close);

  // The typed text narrows the picker too, so a value can be reached by typing it.
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((group) => ({ ...group, options: group.options.filter((option) => option.label.toLowerCase().includes(needle) || group.label.toLowerCase().includes(needle)) }))
      .filter((group) => group.options.length > 0);
  }, [groups, query]);

  return (
    <div ref={root} className={cx("relative", className)}>
      <div
        className={cx(
          "flex min-h-8 flex-wrap items-center gap-1 rounded-(--radius-2) border bg-surface py-0.5 pr-1 pl-2.5 text-ui",
          open ? "border-border-focus" : "border-border",
        )}
        onClick={() => input.current?.focus()}
      >
        <Search size={14} className="mr-0.5 shrink-0 text-faint" />
        {chips.map(({ group, value, option }) => (
          <span key={`${group.id}:${value}`} className="inline-flex h-6 items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft pr-1 pl-2 text-body leading-none text-accent">
            <span className="text-micro font-semibold uppercase tracking-[0.05em] opacity-70">{group.label}</span>
            {option?.icon ? <span className="inline-flex items-center [&>svg]:h-3 [&>svg]:w-3">{option.icon}</span> : null}
            <span className="font-medium">{option?.label ?? value}</span>
            <button
              type="button"
              aria-label={t("ui.filterBox.removeChip", { group: group.label, value })}
              onClick={(event) => {
                event.stopPropagation();
                group.onToggle(value);
              }}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-accent/15"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={query}
          onChange={(event) => {
            onQuery(event.target.value);
            if (event.target.value.trim()) setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && query === "" && chips.length > 0) {
              const last = chips[chips.length - 1]!;
              last.group.onToggle(last.value);
            }
          }}
          placeholder={chips.length ? t("ui.filterBox.addText") : placeholder}
          aria-label={placeholder}
          className="h-6 min-w-32 flex-1 bg-transparent outline-none placeholder:text-faint"
        />
        {activeCount > 0 ? (
          <button type="button" aria-label={t("ui.filterBox.clearAll")} onClick={(event) => { event.stopPropagation(); onClearAll(); }} className="inline-flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-surface-3 hover:text-text">
            <X size={13} />
          </button>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          aria-label={t("ui.filterBox.filters")}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          className={cx("inline-flex h-6 items-center gap-1 rounded-(--radius-1) px-1.5 text-body hover:bg-surface-3", open ? "text-text" : "text-muted")}
        >
          <SlidersHorizontal size={13} /> {t("ui.filterBox.filters")} <ChevronDown size={12} className={cx("transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open ? (
        <div role="dialog" aria-label={t("ui.filterBox.filters")} className="absolute top-full left-0 z-40 mt-1 w-full min-w-[520px] rounded-(--radius-3) border border-border bg-surface shadow-(--shadow-2)">
          {query.trim() ? (
            <p className="border-b border-border px-3 py-2 text-label text-muted">
              {t("ui.filterBox.matching", { query: query.trim() })}
            </p>
          ) : null}
          <div className="flex flex-col divide-y divide-border">
            {visibleGroups.map((group) => (
              <section key={group.id} className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-3 px-3 py-2">
                <h4 className="kicker pt-1.5 leading-none">
                  {group.label}
                  {group.selected.length ? <span className="ml-1 text-accent normal-case tracking-normal">{group.selected.length}</span> : null}
                </h4>
                <div className="flex flex-wrap gap-1">
                  {group.options.map((option) => {
                    const active = group.selected.includes(option.value);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={active}
                        onClick={() => group.onToggle(option.value, { clearQuery: query.trim() !== "" })}
                        className={cx(
                          "inline-flex h-6.5 items-center gap-1.5 rounded-full border px-2.5 text-body transition-colors",
                          active
                            ? "border-accent bg-accent text-accent-contrast"
                            : option.count === 0
                              ? "border-border text-faint hover:border-border-strong"
                              : "border-border bg-surface text-text hover:border-border-strong hover:bg-surface-2",
                        )}
                      >
                        {active ? <Check size={11} /> : null}
                        {option.icon ? <span className="inline-flex items-center [&>svg]:h-3 [&>svg]:w-3">{option.icon}</span> : null}
                        <span className="min-w-0 truncate-1">{option.label}</span>
                        {option.count !== undefined ? <span className={cx("text-meta tabular-nums", active ? "text-accent-contrast/80" : "text-faint")}>{option.count}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
            {visibleGroups.length === 0 ? <p className="px-3 py-2 text-body text-faint">{t("ui.filterBox.noMatch")}</p> : null}
          </div>
          <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-label text-muted">
            <span>{activeCount ? t("ui.filterBox.activeFilter", { count: activeCount }) : t("ui.filterBox.noFilter")}</span>
            <span className="flex items-center gap-3">
              {activeCount ? <button type="button" onClick={onClearAll} className="hover:text-text">{t("ui.filterBox.clearAllShort")}</button> : null}
              <button type="button" onClick={() => setOpen(false)} className="hover:text-text">{t("ui.filterBox.done")}</button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
