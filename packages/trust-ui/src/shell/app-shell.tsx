import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router";
import { ExtensionPage } from "../extensions/extensions.js";
import { usePlanEventsBridge } from "../lib/plan-events.js";
import { useResolvedTheme } from "../lib/preferences.js";
import { Header } from "./header.js";
import { isManagementPath, MobileNavigationProvider, useMobileNavigation } from "./mobile-navigation.js";
import { PageBoundary } from "./page-boundary.js";
import { Sidebar } from "./sidebar.js";
import "./mobile-navigation.css";
import "./plan-mobile.css";

/** The extension a workspace address belongs to: /extensions/<id> and every address below it. */
export function workspaceExtension(pathname: string): string | null {
  if (isManagementPath(pathname) || pathname.startsWith("/extensions/sources/")) return null;
  const match = /^\/extensions\/([^/]+)(?:\/.*)?$/.exec(pathname);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

export function AppShell() {
  const { pathname } = useLocation();
  // A bare phone workspace keeps its nested addresses without the shell.
  const bare = /^\/mobile\/([^/]+)\/.+$/.exec(pathname);
  if (bare && !pathname.startsWith("/mobile/apps/"))
    return <ExtensionPage bare extension={decodeURIComponent(bare[1] ?? "")} />;
  return (
    <MobileNavigationProvider>
      <ShellFrame />
    </MobileNavigationProvider>
  );
}

function ShellFrame() {
  const { t } = useTranslation();
  const drawer = useMobileNavigation();
  const theme = useResolvedTheme();
  const location = useLocation();
  const isDocumentation = location.pathname === "/docs" || location.pathname.startsWith("/docs/");
  const isExtension = location.pathname === "/extensions" || location.pathname.startsWith("/extensions/");
  // A workspace takes the whole phone screen; management pages keep a navigation drawer.
  const isManagement = isManagementPath(location.pathname);
  const workspace = workspaceExtension(location.pathname);
  const isWorkspace = workspace !== null;
  const isPlan = location.pathname.startsWith("/plans/");
  usePlanEventsBridge();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <div
      className={`flex h-full flex-col overflow-hidden bg-bg text-text ${isDocumentation || isExtension || isPlan ? "min-w-0" : "min-w-[720px]"} ${isWorkspace ? "extension-shell" : ""} ${isManagement ? "mobile-shell" : ""} ${isPlan ? "plan-shell" : ""}`}
      data-drawer={drawer.open ? "open" : "closed"}
    >
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <button
          type="button"
          className="mobile-backdrop"
          aria-label={t("shell.nav.close")}
          tabIndex={-1}
          onClick={() => drawer.setOpen(false)}
        />
        <main
          className={`relative min-w-0 flex-1 ${isExtension ? "overflow-auto [scrollbar-gutter:stable]" : "overflow-hidden"}`}
        >
          <PageBoundary>{workspace !== null ? <ExtensionPage extension={workspace} /> : <Outlet />}</PageBoundary>
        </main>
      </div>
    </div>
  );
}
