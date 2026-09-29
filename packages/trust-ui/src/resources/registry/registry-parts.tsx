import type {
  RegistryContentCategory,
  RegistryInstallationSteps,
  RegistryPackageItem,
  RegistrySourceKind,
  RegistryStep,
} from "@trust/extension-sdk";
import { ChevronRight, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";

import { cx } from "../../lib/format.js";
import { mutationError, mutationErrorDetails } from "../../lib/mutations.js";
import { Badge } from "../../ui/badge.js";
import { type Crumb, PageHeader } from "../../ui/breadcrumb.js";
import { EmptyState, ErrorBox } from "../../ui/states.js";
import { accessDenied, registryFailure, type useRefreshIndex } from "./registry-data.js";

/* Small bricks shared by the registry pages: context-preserving links, category badges, folded sections,
   installation steps, reported items and registry failures. */

export const REGISTRY_HOME = "/extensions";
const CATEGORIES: readonly RegistryContentCategory[] = ["extension", "procedures", "operations"];
const STEPS: readonly (keyof RegistryInstallationSteps)[] = [
  "acquisition",
  "verification",
  "build",
  "placement",
  "catalog",
  "extension",
];

/** The two entry pages of extension management; each remembers its own filter and selected row. */
export type RegistryArea = "installed" | "sources";
const HOMES: Record<RegistryArea, string> = { installed: REGISTRY_HOME, sources: `${REGISTRY_HOME}/sources` };
const homeKey = (area: RegistryArea) => `trust.ui.registry.home.${area}`;
export const registryArea = (pathname: string): RegistryArea =>
  pathname === HOMES.sources || pathname.startsWith(`${HOMES.sources}/`) ? "sources" : "installed";

function rememberedHome(area: RegistryArea): string {
  try {
    const value = sessionStorage.getItem(homeKey(area));
    return value && new URL(value, window.location.origin).pathname === HOMES[area] ? value : HOMES[area];
  } catch {
    return HOMES[area];
  }
}

function remember(area: RegistryArea, home: string) {
  try {
    sessionStorage.setItem(homeKey(area), home);
  } catch {
    // storage unavailable: the way back falls back to the default view
  }
}

/** Extension management context (the entry page with its filter and selected row) of the current area, restored by
    every way back. */
export function useRegistryContext() {
  const location = useLocation();
  const navigate = useNavigate();
  const area = registryArea(location.pathname);
  const atHome = location.pathname === HOMES[area];
  const current = `${location.pathname}${location.search}`;
  const home = atHome ? current : rememberedHome(area);
  useEffect(() => {
    if (atHome) remember(area, current);
  }, [area, atHome, current]);
  /** Entry page of an area with its remembered filter and selection. */
  const homeTab = (target: RegistryArea) => (target === area ? home : rememberedHome(target));
  /** Row selected on the entry page, restored when coming back from its detail. */
  const selected = atHome ? new URLSearchParams(location.search).get("sel") : null;
  /** Records the row being opened on the entry page, so that every way back selects it again. */
  const select = (key: string) => {
    if (!atHome) return;
    const params = new URLSearchParams(location.search);
    params.set("sel", key);
    const entry = `${location.pathname}?${params.toString()}`;
    remember(area, entry);
    void navigate(entry, { replace: true });
  };
  return { area, atHome, home, homeTab, selected, select };
}

/** The link of a row selected before opening its detail: focused and scrolled into view when the list comes back. */
export function useRestoredSelection<T extends HTMLElement>(selected: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!selected) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return ref;
}

export const packagePath = (name: string) => `/extensions/packages/${encodeURIComponent(name)}`;
export const sourcePath = (name: string) => `/extensions/sources/${encodeURIComponent(name)}`;
export const availablePath = (source: string, name: string, version: string) =>
  `${sourcePath(source)}/packages/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
export const settingsPath = (extension: string) => `/extensions/settings/${encodeURIComponent(extension)}`;

/** The content categories a package actually declares. */
export function CategoryBadges({ categories }: { categories: readonly RegistryContentCategory[] }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex flex-wrap gap-1">
      {CATEGORIES.filter((category) => categories.includes(category)).map((category) => (
        <Badge key={category} tone="info">
          {t(`registry.categories.${category}`)}
        </Badge>
      ))}
    </span>
  );
}

export interface TableColumn {
  readonly key: string;
  readonly label: string;
  /** Announced to assistive technology only (an actions column). */
  readonly srOnly?: boolean;
  /** Hidden below the large breakpoint, where the row keeps only its essential columns. */
  readonly wide?: boolean;
}

/** Registry table: scrolls inside its own box instead of the page, secondary columns fold away on small screens. */
export function DataTable({
  label,
  columns,
  framed = false,
  dense = false,
  children,
}: {
  label: string;
  columns: readonly TableColumn[];
  framed?: boolean;
  dense?: boolean;
  children: ReactNode;
}) {
  const cell = dense ? "px-2 py-1.5" : "px-2 py-2 md:px-3";
  return (
    <div className={cx("min-w-0 overflow-x-auto", framed && "rounded-(--radius-3) border border-border bg-surface")}>
      <table aria-label={label} className="w-full border-separate border-spacing-0 text-left text-body-lg">
        <thead>
          <tr className="text-caption uppercase tracking-[0.06em] text-muted">
            {columns.map((column) => (
              <th
                key={column.key}
                className={cx("border-b border-border font-semibold", cell, column.wide && "hidden lg:table-cell")}
              >
                {column.srOnly ? <span className="sr-only">{column.label}</span> : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody
          className={cx(
            "[&>tr>td]:border-b [&>tr>td]:border-border [&>tr>td]:align-middle",
            dense ? "[&>tr>td]:px-2 [&>tr>td]:py-1.5" : "[&>tr>td]:px-2 [&>tr>td]:py-2.5 md:[&>tr>td]:px-3",
          )}
        >
          {children}
        </tbody>
      </table>
    </div>
  );
}

/** Class of a cell that belongs to a `wide` column. */
export const WIDE_CELL = "hidden lg:table-cell";

/** Outcome of an index refresh: pending, what was read, or the refusal. An installed package never changes. */
export function RefreshOutcome({ refresh }: { refresh: ReturnType<typeof useRefreshIndex> }) {
  const { t } = useTranslation();
  if (refresh.isPending)
    return (
      <Notice tone="info">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {t("registry.refresh.running")} <span className="mono">{refresh.variables}</span>
      </Notice>
    );
  if (refresh.isSuccess)
    return (
      <Notice tone="success">
        {t("registry.refresh.done", {
          source: refresh.data.source.name,
          count: refresh.data.packages.length,
          revision: refresh.data.revision.slice(0, 12),
        })}{" "}
        {t("registry.refresh.noUpdate")}
      </Notice>
    );
  if (refresh.isError) return <RegistryFailureBox error={refresh.error} title={t("registry.refresh.failed")} />;
  return null;
}

/** A package page reached for a name that is not installed. */
export function PackageMissing({ name }: { name: string }) {
  const { t } = useTranslation();
  const { home } = useRegistryContext();
  return (
    <RegistryPage crumbs={[{ label: name, mono: true }]} title={name}>
      <EmptyState
        title={t("registry.package.notInstalled")}
        body={t("registry.package.notInstalledBody")}
        action={
          <Link to={home} className="text-accent hover:underline">
            {t("extensions.back")}
          </Link>
        }
      />
    </RegistryPage>
  );
}

/** Outcome line of an action: pending, success or refusal. */
export function Notice({ tone, children }: { tone: "info" | "success" | "danger"; children: ReactNode }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx(
        "flex flex-wrap items-center gap-2 rounded-(--radius-2) border px-3 py-2 text-body-lg",
        tone === "success" && "border-success/30 bg-success-soft",
        tone === "danger" && "border-danger/30 bg-danger-soft text-danger",
        tone === "info" && "border-info/30 bg-info-soft",
      )}
    >
      {children}
    </div>
  );
}

export function SourceKindBadge({ kind }: { kind: RegistrySourceKind }) {
  const { t } = useTranslation();
  return <Badge tone="neutral">{t(`registry.sources.kind.${kind}`)}</Badge>;
}

/** Card section with a title line and optional actions. */
export function Panel({
  title,
  actions,
  tone = "neutral",
  children,
  className,
  labelledBy,
}: {
  title: ReactNode;
  actions?: ReactNode;
  tone?: "neutral" | "danger";
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={cx(
        "min-w-0 rounded-(--radius-3) border bg-surface p-4",
        tone === "danger" ? "border-danger/40" : "border-border",
        className,
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={labelledBy} className="text-subhead font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Progressive disclosure: a folded section whose summary carries a count or a badge. */
export function Fold({
  title,
  meta,
  open = false,
  children,
}: {
  title: string;
  meta?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="group rounded-(--radius-2) border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-ui font-medium">
        <ChevronRight size={13} className="shrink-0 text-muted transition-transform group-open:rotate-90" />
        <span>{title}</span>
        {meta ? <span className="ml-auto flex items-center gap-1 text-label text-muted">{meta}</span> : null}
      </summary>
      <div className="border-t border-border px-3 py-2">{children}</div>
    </details>
  );
}

/** Installation steps: completed, skipped, failed at the reported step, or not run after it. */
export function StepsStrip({
  steps,
  failedAt,
}: {
  steps?: RegistryInstallationSteps | undefined;
  failedAt?: RegistryStep | undefined;
}) {
  const { t } = useTranslation();
  // An uninstallation has no installation step: nothing is marked failed.
  const failedIndex = failedAt && failedAt !== "uninstall" ? STEPS.indexOf(failedAt) : -1;
  return (
    <ol aria-label={t("registry.steps.label")} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {STEPS.map((step, index) => {
        const status = steps
          ? steps[step]
          : failedIndex === index
            ? "failed"
            : failedIndex >= 0 && index > failedIndex
              ? "notRun"
              : failedIndex >= 0
                ? "completed"
                : "notRun";
        return (
          <li
            key={step}
            data-step={step}
            data-status={status}
            className={cx(
              "rounded-(--radius-2) border px-2.5 py-2",
              status === "completed" && "border-success/30 bg-success-soft",
              status === "failed" && "border-danger/40 bg-danger-soft",
              (status === "skipped" || status === "notRun") && "border-dashed border-border",
            )}
          >
            <span className="block text-body font-semibold">
              {index + 1} · {t(`registry.steps.${step}`)}
            </span>
            <span className="block text-caption text-muted">{t(`registry.steps.status.${status}`)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Items reported by an uninstallation or an update, each with its kind, identity and reason. */
export function ItemList({ items, label }: { items: readonly RegistryPackageItem[]; label: string }) {
  const { t } = useTranslation();
  if (items.length === 0) return <p className="text-body text-faint">{t("registry.items.none")}</p>;
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-border">
      {items.map((item) => (
        <li key={`${item.kind}:${item.name}:${item.version ?? ""}`} className="min-w-0 py-1.5">
          <span className="block text-body-lg">
            <span className="font-medium">{t(`registry.items.kind.${item.kind}`)}</span>{" "}
            <span className="mono break-all text-muted">
              {item.name === "*" ? t("registry.items.all") : item.name}
              {item.version ? `@${item.version}` : ""}
            </span>
          </span>
          {item.reason ? <span className="block text-caption text-muted">{item.reason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** A refused registry action: its reason, the step where it stopped and the useful build output. */
export function RegistryFailureBox({ error, title }: { error: unknown; title?: string }) {
  const { t } = useTranslation();
  const failure = registryFailure(error);
  if (accessDenied(error))
    return (
      <div role="alert">
        <ErrorBox
          message={title ? `${title} ${t("registry.failure.accessDenied")}` : t("registry.failure.accessDenied")}
          details={mutationErrorDetails(error)}
        />
      </div>
    );
  const message = failure?.message ?? mutationError(error) ?? t("registry.failure.unknown");
  return (
    <div role="alert" className="flex flex-col gap-2">
      <ErrorBox message={title ? `${title} ${message}` : message} details={mutationErrorDetails(error)} />
      {failure ? (
        <p className="flex flex-wrap items-center gap-2 text-label text-muted">
          <Badge tone="danger">{t(`registry.failure.reason.${failure.reason}`)}</Badge>
          {failure.step ? (
            <span>
              {t("registry.failure.step")} <strong>{t(`registry.steps.${failure.step}`)}</strong>
            </span>
          ) : null}
        </p>
      ) : null}
      {failure?.output ? (
        <pre
          title={t("registry.failure.output")}
          className="mono max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-(--radius-2) border border-border bg-surface-2 p-2 text-caption"
        >
          {failure.output}
        </pre>
      ) : null}
    </div>
  );
}

/** Two-column definition list used by the summaries. */
export function Facts({ rows }: { rows: Array<[string, ReactNode] | false | undefined> }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body-lg">
      {rows
        .filter((row): row is [string, ReactNode] => Boolean(row))
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Full registry page: breadcrumb from TRUST and Extensions, title, subtitle, actions, then the content. */
export function RegistryPage({
  crumbs,
  title,
  subtitle,
  actions,
  children,
}: {
  crumbs: Crumb[];
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { area, atHome, home } = useRegistryContext();
  // TRUST › Extensions › Installed | Sources › detail; the area crumb is the current page on its entry page.
  const areaCrumb: Crumb = {
    label: t(area === "sources" ? "registry.nav.sources" : "registry.nav.installed"),
    ...(atHome ? {} : { to: home }),
  };
  return (
    <div className="min-h-full bg-bg">
      <PageHeader
        crumbs={[{ label: "TRUST", to: "/overview" }, { label: t("registry.nav.section") }, areaCrumb, ...crumbs]}
        title={title}
        {...(subtitle ? { subtitle } : {})}
        actions={actions}
      />
      <div className="flex w-full min-w-0 flex-col gap-4 px-4 py-4 sm:px-6">{children}</div>
    </div>
  );
}
