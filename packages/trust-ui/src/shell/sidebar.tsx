import { ChevronRight, Plus, Settings } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation, useNavigate } from "react-router";

import { cx } from "../lib/format.js";
import { toggleAnchor, usePreference } from "../lib/preferences.js";
import { Count } from "../ui/badge.js";
import { Tooltip } from "../ui/controls.js";
import { AnchorExplorer, AnchorHeaderActions } from "./anchor-explorer.js";
import { overviewAnchor, type ResourceAnchor, resourceAnchors, sections, useAnchorItems } from "./resources.js";

export function Sidebar() {
  const sidebarMode = usePreference("sidebarMode");
  return sidebarMode === "compact" ? <CompactSidebar /> : <ExtendedSidebar />;
}

/* ---------------------------------------------------------------- extended */

function ExtendedSidebar() {
  const { t } = useTranslation();
  const expandedAnchors = usePreference("expandedAnchors");
  return (
    <aside aria-label={t("shell.nav.label")} className="flex h-full w-(--sidebar-w) shrink-0 flex-col overflow-hidden border-r border-border bg-surface">
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-3 pb-2">
        <NavRow to={overviewAnchor.to} icon={<overviewAnchor.icon size={16} strokeWidth={1.8} />} label={t(overviewAnchor.label)} />
        {sections.map((section) => (
          <div key={section.id} className="flex flex-col gap-0.5">
            <span className="kicker px-2 pt-4 pb-1">{t(section.label)}</span>
            {resourceAnchors
              .filter((anchor) => anchor.section === section.id)
              .map((anchor) => (
                <ExtendedAnchor key={anchor.id} anchor={anchor} expanded={anchor.explorable && expandedAnchors.includes(anchor.id)} />
              ))}
          </div>
        ))}
      </nav>
      <div className="flex flex-col gap-0.5 border-t border-border px-2 py-2">
        <NavRow to="/settings" icon={<Settings size={16} strokeWidth={1.8} />} label={t("shell.nav.settings")} />
      </div>
    </aside>
  );
}

function NavRow({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          "flex h-8 items-center gap-2.5 rounded-(--radius-2) px-2 text-ui hover:bg-surface-2",
          isActive ? "bg-surface-3 font-semibold text-text" : "text-text",
        )
      }
    >
      <span className="text-muted">{icon}</span>
      {label}
    </NavLink>
  );
}

function ExtendedAnchor({ anchor, expanded }: { anchor: ResourceAnchor; expanded: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { items } = useAnchorItems(anchor.id);
  const active = location.pathname === anchor.to || location.pathname.startsWith(`${anchor.to}/`);
  const Icon = anchor.icon;
  const label = t(anchor.label);
  const newLabel = t("shell.nav.newItem", { kind: t(anchor.singular) });

  return (
    <div>
      <div className={cx("group/anchor flex h-8 items-center rounded-(--radius-2) pr-1", active ? "bg-surface-3" : "hover:bg-surface-2")}>
        {anchor.explorable ? (
          <button
            aria-label={expanded ? t("shell.nav.collapseAnchor", { anchor: label }) : t("shell.nav.expandAnchor", { anchor: label })}
            aria-expanded={expanded}
            onClick={() => toggleAnchor(anchor.id)}
            className="ml-0.5 inline-flex h-6 w-5 items-center justify-center rounded text-faint hover:text-text"
          >
            <ChevronRight size={13} className={cx("transition-transform", expanded && "rotate-90")} />
          </button>
        ) : (
          <span className="ml-0.5 w-5" />
        )}
        <NavLink
          to={anchor.to}
          end
          className={cx("flex h-full min-w-0 flex-1 items-center gap-2 pl-0.5 text-ui", active ? "font-semibold text-text" : "text-text")}
        >
          <Icon size={16} strokeWidth={1.8} className="shrink-0 text-muted" />
          <span className="truncate-1">{label}</span>
        </NavLink>
        {anchor.explorable ? <Count value={items.length} className="mr-1" /> : null}
        {anchor.createTo ? (
          <button
            aria-label={newLabel}
            title={newLabel}
            onClick={() => navigate(anchor.createTo!)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-faint opacity-0 hover:bg-surface-3 hover:text-text group-hover/anchor:opacity-100 focus-visible:opacity-100"
          >
            <Plus size={14} />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="my-1 ml-[15px] border-l border-border pl-1.5">
          <AnchorExplorer anchor={anchor} />
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- compact */

function CompactSidebar() {
  const { t } = useTranslation();
  const [flyout, setFlyout] = useState<ResourceAnchor | null>(null);
  // The flyout opens level with the hovered icon (clamped to the rail), not pinned to the top.
  const [flyoutTop, setFlyoutTop] = useState(12);
  const railRef = useRef<HTMLElement>(null);
  const openFlyoutAt = (anchor: ResourceAnchor | null, target: HTMLElement) => {
    if (anchor) {
      const rail = railRef.current?.getBoundingClientRect();
      const item = target.getBoundingClientRect();
      const top = rail ? item.top - rail.top - 8 : 12;
      const maxTop = rail ? Math.max(12, rail.height - 360) : top;
      setFlyoutTop(Math.max(12, Math.min(top, maxTop)));
    }
    setFlyout(anchor);
  };
  const closeTimer = useRef<number | undefined>(undefined);

  const cancelClose = () => window.clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setFlyout(null), 220);
  };
  useEffect(() => cancelClose, []);
  useEffect(() => {
    if (!flyout) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFlyout(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [flyout]);

  return (
    <aside ref={railRef} aria-label={t("shell.nav.label")} className="relative flex h-full w-(--sidebar-w-compact) shrink-0 flex-col border-r border-border bg-surface" onPointerLeave={scheduleClose} onPointerEnter={cancelClose}>
      <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto pt-3 pb-2">
        <RailLink to={overviewAnchor.to} label={t(overviewAnchor.label)} icon={<overviewAnchor.icon size={17} strokeWidth={1.8} />} onPointerEnter={() => setFlyout(null)} />
        {sections.map((section) => (
          <div key={section.id} className="flex flex-col items-center gap-1">
            <span className="my-1.5 h-px w-5 bg-border" aria-hidden />
            {resourceAnchors
              .filter((anchor) => anchor.section === section.id)
              .map((anchor) => (
                <RailLink
                  key={anchor.id}
                  to={anchor.to}
                  label={t(anchor.label)}
                  icon={<anchor.icon size={17} strokeWidth={1.8} />}
                  highlighted={flyout?.id === anchor.id}
                  onPointerEnter={(event) => {
                    cancelClose();
                    openFlyoutAt(anchor.explorable ? anchor : null, event.currentTarget);
                  }}
                  onFocus={(event) => {
                    cancelClose();
                    openFlyoutAt(anchor.explorable ? anchor : null, event.currentTarget);
                  }}
                />
              ))}
          </div>
        ))}
      </nav>
      <div className="flex flex-col items-center gap-1 border-t border-border py-2">
        <RailLink to="/settings" label={t("shell.nav.settings")} icon={<Settings size={17} strokeWidth={1.8} />} onPointerEnter={() => setFlyout(null)} />
      </div>
      {flyout ? (
        <div
          role="region"
          aria-label={t("shell.nav.explorer", { anchor: t(flyout.label) })}
          className="absolute left-full z-40 ml-1 w-72 rounded-(--radius-3) border border-border bg-surface p-2 shadow-(--shadow-2)"
          style={{ top: flyoutTop }}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onFocus={cancelClose}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose(); }}
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <NavLink to={flyout.to} onClick={() => setFlyout(null)} className="flex items-center gap-2 text-ui font-semibold hover:text-accent">
              <flyout.icon size={15} strokeWidth={1.8} className="text-muted" />
              {t(flyout.label)}
            </NavLink>
            <AnchorHeaderActions anchor={flyout} onNavigate={() => setFlyout(null)} />
          </div>
          <AnchorExplorer anchor={flyout} onNavigate={() => setFlyout(null)} />
        </div>
      ) : null}
    </aside>
  );
}

function RailLink({ to, label, icon, highlighted, onPointerEnter, onFocus }: { to: string; label: string; icon: ReactNode; highlighted?: boolean; onPointerEnter?: (event: React.PointerEvent<HTMLAnchorElement>) => void; onFocus?: (event: React.FocusEvent<HTMLAnchorElement>) => void }) {
  return (
    <Tooltip label={label}>
      <NavLink
        to={to}
        aria-label={label}
        onPointerEnter={onPointerEnter}
        onFocus={onFocus}
        className={({ isActive }) =>
          cx(
            "inline-flex h-8 w-8 items-center justify-center rounded-(--radius-2) hover:bg-surface-2",
            isActive ? "bg-surface-3 text-text" : "text-muted",
            highlighted && "bg-surface-2 text-text",
          )
        }
      >
        {icon}
      </NavLink>
    </Tooltip>
  );
}
