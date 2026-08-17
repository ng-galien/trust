import { Activity, FlaskConical, GitBranch, History, TerminalSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { plural, relativeTime } from "../../lib/format.js";
import { useLiveMode } from "../../lib/plan-events.js";
import { useExpert } from "../../lib/preferences.js";
import { useEnvironments, useHealth, useHistory, useOperations, usePlans, useProcedures } from "../../lib/runtime-context.js";
import { StatusBadge } from "../../ui/badge.js";
import { PageHeader } from "../../ui/breadcrumb.js";
import { HistoryTable } from "../history/history-home.js";
import { ModeBadge, ProgressBar } from "../plans/parts.js";

/* Overview — the dashboard: runtime health, the catalog at a glance, what is running, the latest verdicts. */

export function OverviewHome() {
  const { t } = useTranslation();
  const expert = useExpert();
  const health = useHealth();
  const operations = useOperations();
  const procedures = useProcedures();
  const plans = usePlans();
  const environments = useEnvironments();
  const latest = useHistory({}, 8);
  const live = useLiveMode();
  const livePlans = (plans.data ?? []).filter((plan) => plan.mode === "live");
  const dryRuns = (plans.data ?? []).filter((plan) => plan.mode === "dry-run");
  const running = [...livePlans, ...dryRuns].filter((plan) => plan.workState === "IN_PROGRESS").sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg">
      <PageHeader crumbs={[{ label: "TRUST" }, { label: t("overview.home.crumb") }]} title={t("overview.home.title")} />
      <div className="grid gap-4 p-6 [&>*]:min-w-0 md:grid-cols-4">
        <Tile to="/operations" icon={<TerminalSquare size={15} />} label={t("overview.home.tiles.operations")} value={operations.data?.length ?? "…"} />
        <Tile to="/procedures" icon={<GitBranch size={15} />} label={t("overview.home.tiles.procedures")} value={procedures.data?.length ?? "…"} />
        <Tile to="/plans" icon={<Activity size={15} />} label={t("overview.home.tiles.plans")} value={livePlans.length} hint={t("overview.home.tiles.inProgress", { count: livePlans.filter((plan) => plan.workState === "IN_PROGRESS").length })} />
        <Tile to="/dry-runs" icon={<FlaskConical size={15} />} label={t("overview.home.tiles.dryRuns")} value={dryRuns.length} hint={t("overview.home.tiles.inProgress", { count: dryRuns.filter((plan) => plan.workState === "IN_PROGRESS").length })} />
      </div>
      <div className="grid gap-4 px-6 pb-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="rounded-(--radius-3) border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-2"><span className="kicker">{t("overview.home.inFlight.kicker")}</span><span className="text-caption text-faint">{plural(running.length, "plan")}</span></div>
          {running.length === 0 ? <p className="px-4 py-3 text-body-lg text-muted">{t("overview.home.inFlight.nothing")}</p> : null}
          <ul>
            {running.slice(0, 12).map((plan) => (
              <li key={plan.plan} className="border-b border-border last:border-b-0">
                <Link to={`/${plan.mode === "dry-run" ? "dry-runs" : "plans"}/${encodeURIComponent(plan.plan)}`} className="flex items-center gap-3 px-4 py-2 hover:bg-surface-2">
                  <ModeBadge mode={plan.mode} />
                  <span className="min-w-0 flex-1"><span className="mono block truncate text-body-lg font-medium">{plan.plan}</span><span className="block truncate text-caption text-muted">{expert ? t("overview.home.inFlight.metaRevision", { procedure: plan.procedure, environment: plan.environment, revision: String(plan.revision) }) : t("overview.home.inFlight.meta", { procedure: plan.procedure, environment: plan.environment })}</span></span>
                  <ProgressBar satisfied={plan.satisfiedChecks} total={plan.checkCount} />
                  <span className="text-caption text-faint">{relativeTime(plan.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-(--radius-3) border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="kicker">{t("overview.home.runtime.kicker")}</span>
            <StatusBadge state={health.data ? "OK" : health.isLoading ? "…" : "UNAVAILABLE"} />
          </div>
          <div className="grid grid-cols-3 gap-3 px-4 py-3 text-body">
            <Stat label={t("overview.home.runtime.environments")} value={environments.data?.length ?? "…"} />
            <Stat label={t("overview.home.runtime.openSessions")} value={(plans.data ?? []).filter((plan) => plan.sessionState === "OPEN").length} />
            <Stat label={t("overview.home.runtime.updates")} value={live ? t("overview.home.runtime.live") : t("overview.home.runtime.polling")} {...(live ? { tone: "success" as const } : {})} />
          </div>
        </section>
      </div>
      <section className="mx-6 mb-6 rounded-(--radius-3) border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="kicker">{t("overview.home.latest.kicker")}</span>
          <Link to="/history" className="inline-flex items-center gap-1 text-body text-accent hover:underline"><History size={12} /> {t("overview.home.latest.link")}</Link>
        </div>
        {latest.rows.length === 0 ? <p className="px-4 py-3 text-body-lg text-muted">{latest.isLoading ? t("overview.home.latest.reading") : t("overview.home.latest.none")}</p> : <HistoryTable rows={latest.rows} stickyHeader={false} />}
      </section>
    </div>
  );
}

function Tile({ to, icon, label, value, hint }: { to: string; icon: ReactNode; label: string; value: number | string; hint?: string }) {
  return (
    <Link to={to} className="card-link flex items-center gap-3 rounded-(--radius-3) border border-border bg-surface px-4 py-3">
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-(--radius-2) bg-surface-2 text-muted">{icon}</span>
      <span className="min-w-0"><span className="block text-heading font-semibold leading-tight">{value}</span><span className="block text-body text-muted">{label}{hint ? <span className="text-faint"> · {hint}</span> : null}</span></span>
    </Link>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "success" | "danger" }) {
  return <span><span className={`block text-title font-semibold ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : ""}`}>{value}</span><span className="text-muted">{label}</span></span>;
}
