import { loadRemote, registerRemotes } from "@module-federation/enhanced/runtime";
import { Component, type ComponentType, type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router";
import { useExtensions } from "../lib/extensions.js";
import { useRuntime } from "../lib/runtime-context.js";
import { Breadcrumb } from "../ui/breadcrumb.js";
import { createExtensionTransport } from "./transport.js";
import "./extensions.css";

import type { ExtensionPageProps } from "@trust/extension-sdk";

const button = "rounded border border-border px-3 py-1.5 text-ui hover:bg-surface-2 disabled:opacity-40";

class RemoteBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
/**
 * The page of one extension. A workspace (an extension with a UI) owns every address below /extensions/<id>; the
 * shell passes its identity, since nested workspace addresses have no route parameter of their own.
 */
export function ExtensionPage({ bare = false, extension: workspace }: { bare?: boolean; extension?: string }) {
  const params = useParams();
  const id = workspace ?? params.extension;
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
          setRemote(() => module.default);
        }
      })
      .catch(() => {
        if (!active) return;
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
  }, [remoteName, remoteEntry, remoteModule, baseUrl, retry, authentication]);
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
      {/* A workspace presents itself; the Extensions header remains only for an extension without a UI. */}
      {!bare && catalog.isSuccess && !extension?.ui && (
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
