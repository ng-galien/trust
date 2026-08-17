import { ArrowRight, Copy, ExternalLink, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";

import { cx } from "../lib/format.js";
import { mutationError } from "../lib/mutations.js";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/confirm.js";
import { SearchInput } from "../ui/controls.js";
import { Menu } from "../ui/menu.js";
import { type AnchorItem, type ResourceAnchor, useAnchorItems } from "./resources.js";

const visibleLimit = 8;

/** Explorer body of one anchor: filter, first items, escalation to the catalog, creation. */
export function AnchorExplorer({ anchor, onNavigate, className }: { anchor: ResourceAnchor; onNavigate?: () => void; className?: string }) {
  const { t } = useTranslation();
  const { items, loading, error } = useAnchorItems(anchor.id);
  const [query, setQuery] = useState("");
  const location = useLocation();
  const currentPath = `${location.pathname}${location.search}`;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter((item) => `${item.label} ${item.meta ?? ""}`.toLowerCase().includes(needle)) : items;
  }, [items, query]);
  const visible = filtered.slice(0, visibleLimit);
  const hidden = filtered.length - visible.length;
  const anchorLabel = t(anchor.label).toLowerCase();

  return (
    <div className={cx("flex flex-col gap-1", className)}>
      {items.length > 4 ? (
        <SearchInput size="sm" value={query} onChange={setQuery} placeholder={t("shell.nav.filter", { anchor: anchorLabel })} className="mb-1" />
      ) : null}
      {loading ? <p className="px-2 py-1 text-label text-faint">{t("common.states.loading")}</p> : null}
      {error ? <p className="px-2 py-1 text-label text-danger">{error}</p> : null}
      {!loading && !error && filtered.length === 0 ? (
        <p className="px-2 py-1 text-label text-faint">{query ? t("shell.explorer.noMatch") : t("shell.explorer.noneYet", { anchor: anchorLabel })}</p>
      ) : null}
      {visible.map((item, index) => {
        const previous = visible[index - 1];
        const heading = item.group && item.group.id !== previous?.group?.id;
        return (
          <div key={item.id} className={cx(item.group && "pl-2")}>
            {heading && item.group ? (
              <Link to={item.group.to} onClick={onNavigate} className="-ml-2 mt-1 flex items-center gap-1 px-2 py-0.5 text-meta font-semibold uppercase tracking-[0.06em] text-faint hover:text-text" title={t("shell.explorer.openProcedure", { procedure: item.group.id })}>
                <span className="truncate-1">{item.group.label}</span>
              </Link>
            ) : null}
            <AnchorItemRow
              anchor={anchor}
              item={item}
              current={currentPath === item.to || decodeURIComponent(location.pathname) === decodeURIComponent(item.to)}
              onNavigate={onNavigate}
            />
          </div>
        );
      })}
      <div className="mt-1 flex items-center justify-between gap-2 px-1">
        <Link
          to={`${anchor.to}?view=list${query ? `&q=${encodeURIComponent(query)}` : ""}`}
          onClick={onNavigate}
          className="inline-flex items-center gap-1 text-label text-muted hover:text-text"
        >
          {hidden > 0 ? t("shell.nav.more", { count: hidden }) : ""}{t("shell.nav.openCatalog")} <ArrowRight size={11} />
        </Link>
        {anchor.createTo ? (
          <Link to={anchor.createTo} onClick={onNavigate} className="inline-flex items-center gap-1 text-label text-muted hover:text-text">
            <Plus size={11} /> {t("common.actions.new")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function AnchorItemRow({ anchor, item, current, onNavigate }: { anchor: ResourceAnchor; item: AnchorItem; current: boolean; onNavigate?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const remove = item.remove;
  const removeBlocked = remove ? remove.blocked : t(anchor.managementNote ?? "shell.nav.notAvailable");
  const onRemove = async () => {
    if (!remove) return;
    setBusy(true); setError(undefined);
    try { await remove.run(); } catch (failure) { setError(mutationError(failure)); } finally { setBusy(false); setConfirming(false); }
  };
  return (
    <div className={cx("group/item flex flex-col rounded-(--radius-1)", current ? "bg-surface-3" : "hover:bg-surface-2")}>
    <div className="flex items-center">
      <Link
        to={item.to}
        onClick={onNavigate}
        title={item.label}
        className={cx("flex min-w-0 flex-1 items-center gap-2 py-1 pl-2 pr-1 text-body", current ? "font-semibold text-text" : "text-text")}
      >
        {item.state ? <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", item.state === "COMPLETE" ? "bg-success" : "bg-info")} /> : null}
        <span className="mono truncate-1">{item.label}</span>
        {item.meta ? <span className="ml-auto shrink-0 text-meta text-faint">{item.meta}</span> : null}
      </Link>
      <Menu
        trigger={({ open, toggle }) => (
          <button
            aria-label={t("shell.nav.actionsFor", { item: item.label })}
            onClick={toggle}
            className={cx(
              "mr-0.5 inline-flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-surface-3 hover:text-text",
              open ? "opacity-100" : "opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100",
            )}
          >
            <MoreHorizontal size={14} />
          </button>
        )}
        items={[
          { label: t("common.actions.open"), icon: <ExternalLink size={13} />, onSelect: () => { onNavigate?.(); navigate(item.to); } },
          ...(item.duplicateTo ? [{ label: t("common.actions.duplicate"), icon: <Copy size={13} />, onSelect: () => { onNavigate?.(); navigate(item.duplicateTo!); } }] : []),
          { label: "", separator: true },
          removeBlocked
            ? { label: t("common.actions.delete"), icon: <Trash2 size={13} />, danger: true, disabled: true, disabledReason: removeBlocked }
            : { label: t("common.actions.delete"), icon: <Trash2 size={13} />, danger: true, onSelect: () => setConfirming(true) },
        ]}
      />
      {remove ? (
        <ConfirmDialog open={confirming} title={t("shell.nav.deleteItem", { kind: t(anchor.singular), item: item.label })} body={remove.body} confirmLabel={t("common.actions.delete")} tone="danger" busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => void onRemove()} />
      ) : null}
    </div>
    {error ? <span className="px-2 pb-1 text-caption text-danger">{error}</span> : null}
    </div>
  );
}

export function AnchorHeaderActions({ anchor, onNavigate }: { anchor: ResourceAnchor; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (!anchor.createTo) return null;
  return (
    <Button size="sm" icon={<Plus size={13} />} onClick={() => { onNavigate?.(); navigate(anchor.createTo!); }}>
      {t("common.actions.new")}
    </Button>
  );
}
