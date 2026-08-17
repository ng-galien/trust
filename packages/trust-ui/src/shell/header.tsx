import { CircleHelp, Moon, PanelLeftClose, PanelLeftOpen, Search, Server, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";

import { cx } from "../lib/format.js";
import { type Density, updatePreferences, usePreference, useResolvedTheme } from "../lib/preferences.js";
import { useCurrentEnvironment } from "../lib/environment.js";
import { useLiveMode } from "../lib/plan-events.js";
import { useHealth } from "../lib/runtime-context.js";
import { IconButton } from "../ui/button.js";
import { Kbd, SegmentedControl } from "../ui/controls.js";
import { Select } from "../ui/select.js";
import { resourceAnchors, useAnchorItems } from "./resources.js";

export function Header() {
  const { t } = useTranslation();
  const health = useHealth();
  const theme = useResolvedTheme();
  const sidebarMode = usePreference("sidebarMode");
  const compact = sidebarMode === "compact";
  const live = useLiveMode();
  const status = health.isLoading ? "checking" : health.isSuccess ? "healthy" : "unavailable";

  return (
    <header className="flex h-(--header-h) shrink-0 items-center gap-6 border-b border-border bg-surface px-3">
      <IconButton
        label={compact ? t("shell.nav.expand") : t("shell.nav.collapse")}
        aria-expanded={!compact}
        onClick={() => updatePreferences({ sidebarMode: compact ? "extended" : "compact" })}
        className="-mr-4"
      >
        {compact ? <PanelLeftOpen size={17} strokeWidth={1.8} /> : <PanelLeftClose size={17} strokeWidth={1.8} />}
      </IconButton>
      <a href="/overview" className="flex w-40 shrink-0 items-center gap-2.5" aria-label={t("shell.nav.home")}>
        <span className="grid h-6 w-6 place-items-center rounded-(--radius-1) bg-surface-inverse text-body font-bold text-inverse">T</span>
        <span className="text-ui font-bold tracking-[0.18em]">TRUST</span>
      </a>
      <GlobalSearch />
      <div className="ml-auto flex items-center gap-2">
        <EnvironmentSwitcher />
        <DensitySwitch />
        <button
          onClick={() => void health.refetch()}
          className="flex items-center gap-2 rounded-(--radius-2) px-2 py-1 text-body font-medium text-muted hover:bg-surface-2 hover:text-text"
          title={status === "healthy" ? (live ? t("shell.runtime.liveHint") : t("shell.runtime.pollingHint")) : t("shell.runtime.refresh")}
        >
          <span
            className={cx(
              "h-1.5 w-1.5 rounded-full",
              status === "healthy" ? "bg-success" : status === "checking" ? "animate-pulse bg-warning" : "bg-danger",
            )}
          />
          {status === "healthy" ? (live ? t("shell.runtime.live") : t("shell.runtime.healthy")) : status === "checking" ? t("shell.runtime.checking") : t("shell.runtime.unavailable")}
        </button>
        <HelpLink />
        <IconButton label={theme === "dark" ? t("shell.theme.useLight") : t("shell.theme.useDark")} onClick={() => updatePreferences({ theme: theme === "dark" ? "light" : "dark" })}>
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>
      </div>
    </header>
  );
}

/** The documentation page of the current screen (route prefix → page below /docs). Kept static: the docs are their own chunk. */
const helpPages: Array<[string, string]> = [
  ["/operations", "operations/authoring"],
  ["/procedures", "procedures/authoring"],
  ["/environments", "environments"],
  ["/dry-runs", "plans/dry-run"],
  ["/plans", "plans/follow"],
  ["/history", "plans/history"],
  ["/settings", "screens"],
  ["/overview", "screens"],
];

function HelpLink() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  if (pathname.startsWith("/docs")) return null;
  const page = helpPages.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1] ?? "";
  return (
    <Link to={`/docs/${page}`} aria-label={t("shell.help")} title={t("shell.help")} className="inline-flex h-8 w-8 items-center justify-center rounded-(--radius-2) text-muted hover:bg-surface-2 hover:text-text">
      <CircleHelp size={16} />
    </Link>
  );
}

/** Operator / expert: how much the interface shows (a preference, never in the URL). */
function DensitySwitch() {
  const { t } = useTranslation();
  const density = usePreference("density");
  return (
    <span data-doc="shell.density"><SegmentedControl<Density>
      ariaLabel={t("shell.density.label")}
      size="sm"
      value={density}
      onChange={(next) => updatePreferences({ density: next })}
      options={[
        { value: "operator", label: t("shell.density.operator"), title: t("shell.density.operatorHint") },
        { value: "expert", label: t("shell.density.expert"), title: t("shell.density.expertHint") },
      ]}
    /></span>
  );
}

/** The current environment: the context of every run and engagement (a preference, never in the URL). */
function EnvironmentSwitcher() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentEnvironment();
  return (
    <div className="flex items-center gap-1" title={t("shell.environment.label")} data-doc="shell.environment">
      <Server size={14} className="text-muted" />
      <Select
        ariaLabel={t("shell.environment.label")}
        size="sm"
        align="end"
        value={current.name ?? ""}
        onChange={(name) => (name === "__manage" ? navigate("/environments") : current.select(name))}
        placeholder={current.loading ? t("common.actions.loading") : t("shell.environment.none")}
        options={[
          ...current.environments.map((entry) => ({ value: entry.name, label: <span className="mono">{entry.name}</span>, meta: t("common.count.value", { count: Object.keys(entry.values).length }) })),
          { value: "__manage", label: t("shell.environment.manage") },
        ]}
      />
    </div>
  );
}

function GlobalSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const operations = useAnchorItems("operations");
  const procedures = useAnchorItems("procedures");
  const plans = useAnchorItems("plans");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const match = (label: string) => label.toLowerCase().includes(needle);
    return [
      { anchor: resourceAnchors.find((anchor) => anchor.id === "operations")!, items: operations.items.filter((item) => match(item.label)).slice(0, 5) },
      { anchor: resourceAnchors.find((anchor) => anchor.id === "procedures")!, items: procedures.items.filter((item) => match(item.label)).slice(0, 5) },
      { anchor: resourceAnchors.find((anchor) => anchor.id === "plans")!, items: plans.items.filter((item) => match(item.label)).slice(0, 5) },
    ].filter((group) => group.items.length > 0);
  }, [query, operations.items, procedures.items, plans.items]);

  const first = groups[0]?.items[0];

  return (
    <div ref={root} className="relative w-full max-w-xl" data-doc="shell.search">
      <label className="relative flex items-center">
        <Search size={14} className="pointer-events-none absolute left-2.5 text-faint" />
        <input
          ref={input}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && first) { navigate(first.to); setOpen(false); setQuery(""); }
            if (event.key === "Escape") { setOpen(false); input.current?.blur(); }
          }}
          placeholder={t("shell.search.placeholder")}
          aria-label={t("shell.search.label")}
          className="h-8 w-full rounded-(--radius-2) border border-border bg-bg pl-8 pr-14 text-ui text-text placeholder:text-faint focus:border-border-focus focus:bg-surface"
        />
        <span className="pointer-events-none absolute right-2 flex items-center gap-0.5"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
      </label>
      {open && groups.length > 0 ? (
        <div className="absolute top-full left-0 z-50 mt-1 w-full rounded-(--radius-2) border border-border bg-surface p-1 shadow-(--shadow-2)">
          {groups.map(({ anchor, items }) => (
            <div key={anchor.id} className="py-1">
              <span className="kicker block px-2 pb-1">{t(anchor.label)}</span>
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => { navigate(item.to); setOpen(false); setQuery(""); }}
                  className="flex w-full items-center gap-2 rounded-(--radius-1) px-2 py-1.5 text-left text-body-lg hover:bg-surface-2"
                >
                  <anchor.icon size={14} className="text-muted" />
                  <span className="mono truncate-1">{item.label}</span>
                  {item.meta ? <span className="ml-auto text-caption text-faint">{item.meta}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
