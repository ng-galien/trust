import { loadRemote, registerRemotes } from "@module-federation/enhanced/runtime";
import { ArrowUpRight, Play, Puzzle, RefreshCw, Square, Wrench } from "lucide-react";
import { Component, type ComponentType, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { authenticatedFetch } from "../lib/authentication.js";
import { useExtensions } from "../lib/extensions.js";
import { useRuntime } from "../lib/runtime-context.js";
import { Badge } from "../ui/badge.js";
import { Breadcrumb, PageHeader } from "../ui/breadcrumb.js";
import { Button } from "../ui/button.js";
import { createExtensionTransport } from "./transport.js";
import "./extensions.css";

import type { ExtensionPageProps } from "@trust/extension-sdk";

const button = "rounded border border-border px-3 py-1.5 text-ui hover:bg-surface-2 disabled:opacity-40";

async function request<T>(url: string, method = "GET"): Promise<T> {
  const response = await authenticatedFetch(
    url,
    method === "GET" ? undefined : { method, headers: { "content-type": "application/json" }, body: "{}" },
  );
  if (!response.ok) throw new Error("Extension request failed");
  return response.json() as Promise<T>;
}
export function ExtensionsHome() {
  const { t } = useTranslation();
  const { baseUrl, authentication } = useRuntime();
  const catalog = useExtensions();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  async function act(id: string, action: string) {
    setBusy(id);
    setFailed(false);
    try {
      await request(`${baseUrl}/extensions/${encodeURIComponent(id)}/${action}`, "POST");
    } catch {
      setFailed(true);
    } finally {
      await catalog.refetch();
      setBusy(null);
    }
  }
  return (
    <section className="min-h-full bg-bg">
      <PageHeader
        crumbs={[]}
        title={t("extensions.title")}
        actions={
          <Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => void catalog.refetch()}>
            {t("extensions.refresh")}
          </Button>
        }
      />
      <div className="mx-auto w-full max-w-5xl p-6">
        {(catalog.isError || failed) && (
          <p role="alert" className="mb-4 text-danger">
            {t(failed ? "extensions.actionFailed" : "extensions.failed")}
          </p>
        )}
        {catalog.isLoading && <p role="status">{t("extensions.loading")}</p>}
        {catalog.data?.extensions.length === 0 && <p>{t("extensions.empty")}</p>}
        {catalog.data?.extensions.map((extension) => (
          <article
            key={extension.id}
            className="mb-4 flex flex-wrap items-center justify-between gap-5 rounded-(--radius-3) border border-border bg-surface p-5"
          >
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 font-semibold">
                <Puzzle size={18} className="shrink-0 text-muted" aria-hidden="true" />
                {extension.title}
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge>{extension.version}</Badge>
                <Badge
                  tone={
                    extension.state === "RUNNING"
                      ? "success"
                      : extension.state === "FAILED"
                        ? "danger"
                        : extension.state === "STOPPED"
                          ? "neutral"
                          : "warning"
                  }
                >
                  {t(`extensions.states.${extension.state}`)}
                </Badge>
              </div>
              {extension.error && (
                <p role="alert" className="mt-2 text-danger">
                  {extension.error.message}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {extension.ui && (
                <Link
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-(--radius-2) bg-accent px-3 text-ui font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
                  to={`/extensions/${encodeURIComponent(extension.id)}`}
                >
                  {t("extensions.open")}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              )}
              {(["STOPPED", "FAILED"].includes(extension.state)
                ? (["prepare", "start"] as const)
                : extension.state === "RUNNING"
                  ? (["stop"] as const)
                  : []
              ).map((action) => (
                <Button
                  variant={action === "stop" ? "danger" : "secondary"}
                  icon={
                    action === "stop" ? (
                      <Square size={14} aria-hidden="true" />
                    ) : action === "start" ? (
                      <Play size={14} aria-hidden="true" />
                    ) : (
                      <Wrench size={14} aria-hidden="true" />
                    )
                  }
                  key={action}
                  disabled={busy !== null}
                  onClick={() => void act(extension.id, action)}
                >
                  {t(`extensions.${action}`)}
                </Button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

class RemoteBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function ExtensionPage({ bare = false }: { bare?: boolean }) {
  const { extension: id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useMemo(
    () => ({
      planHref: (plan: string, mode?: string) =>
        `/${mode === "dry-run" ? "dry-runs" : "plans"}/${encodeURIComponent(plan)}`,
      // The current core Procedure view selects the catalog by id, not historical version.
      procedureHref: (procedure: string, _version?: string) => `/procedures/${encodeURIComponent(procedure)}`,
      navigate: (href: string) => {
        void navigate(
          href,
          href.startsWith("/plans/")
            ? { state: { from: `${location.pathname}${location.search}${window.location.hash}` } }
            : undefined,
        );
      },
      search: location.search,
      replaceSearch: (search: string) => {
        void navigate({ pathname: location.pathname, search }, { replace: true });
      },
    }),
    [location.pathname, location.search, navigate],
  );
  const { t, i18n } = useTranslation();
  const { baseUrl, authentication } = useRuntime();
  const catalog = useExtensions();
  const extension = catalog.data?.extensions.find((item) => item.id === id);
  const [Remote, setRemote] = useState<ComponentType<ExtensionPageProps> | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [transport, setTransport] = useState<ExtensionPageProps["transport"]>();
  useEffect(() => {
    setTransport(undefined);
    if (!id) return;
    const connection = createExtensionTransport(baseUrl, id, authentication);
    setTransport(connection.transport);
    const unsubscribe = authentication.subscribe((ready) => {
      if (!ready) {
        connection.dispose();
        setTransport(undefined);
      }
    });
    return () => {
      unsubscribe();
      connection.dispose();
    };
  }, [baseUrl, id, authentication]);
  const remote = extension?.ui;
  const remoteName = remote?.name;
  const remoteEntry = remote?.entry;
  const remoteModule = remote?.module;
  const reportMobile = useCallback(
    (stage: string, code: string) => {
      if (bare && id === "mobile-companion")
        (window as Window & { __trustMobileReport?: (stage: string, code: string) => void }).__trustMobileReport?.(
          stage,
          code,
        );
    },
    [bare, id],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recreate the remote page when the authentication controller changes.
  useEffect(() => {
    let active = true;
    setRemote(null);
    setFailed(false);
    if (remoteName === undefined || remoteEntry === undefined || remoteModule === undefined) return;
    const entry = new URL(`${baseUrl}${remoteEntry}`, window.location.href);
    // Browsers cache a rejected native import; a retry needs a fresh entry URL.
    if (retry > 0) entry.searchParams.set("trustRetry", String(retry));
    registerRemotes([{ name: remoteName, entry: entry.href, type: "module" }], { force: true });
    void loadRemote<{ default: ComponentType<ExtensionPageProps> }>(
      `${remoteName}/${remoteModule.replace(/^\.\//, "")}`,
    )
      .then((module) => {
        if (!module?.default) throw new Error("No extension page");
        if (active) {
          reportMobile("remote-import", "loaded");
          setRemote(() => module.default);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const name = error instanceof Error ? error.name : "unknown";
        reportMobile(
          "remote-import",
          ["TypeError", "SyntaxError", "ReferenceError", "Error"].includes(name) ? name : "unknown",
        );
        if (retry < 2)
          setTimeout(
            () => {
              if (active) setRetry((value) => value + 1);
            },
            500 * (retry + 1),
          );
        else setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [remoteName, remoteEntry, remoteModule, baseUrl, retry, reportMobile, authentication]);
  const fallback = (
    <div role="alert" className="p-6">
      <p>{t("extensions.failed")}</p>
      <button type="button" className={`${button} mt-3`} onClick={() => setRetry((value) => value + 1)}>
        {t("extensions.retry")}
      </button>
    </div>
  );
  return (
    <div className={bare ? "min-h-dvh min-w-0 bg-bg text-text" : "extension-workspace min-h-full min-w-0 flex-1 bg-bg"}>
      {!bare && (
        <div className="bg-surface px-6 pt-4 pb-2">
          <Breadcrumb
            items={[
              { label: t("extensions.title"), to: "/extensions" },
              { label: extension?.title ?? t("extensions.loading") },
            ]}
          />
        </div>
      )}
      {catalog.isError || failed ? (
        fallback
      ) : catalog.isLoading ? (
        <p className="p-6" role="status">
          {t("extensions.loading")}
        </p>
      ) : !extension?.ui ? (
        <p className="p-6">{t("extensions.unavailable")}</p>
      ) : !Remote || !transport ? (
        <p className="p-6" role="status">
          {t("extensions.loading")}
        </p>
      ) : (
        <RemoteBoundary key={`${id}:${retry}`} fallback={fallback}>
          <Remote
            transport={transport}
            apiBase={`${baseUrl}${extension.apiBase}`}
            trustBase={`${baseUrl}/extensions/${encodeURIComponent(extension.id)}/trust`}
            eventsUrl={`${baseUrl}/extensions/${encodeURIComponent(extension.id)}/events`}
            language={i18n.language}
            navigation={navigation}
          />
        </RemoteBoundary>
      )}
    </div>
  );
}
