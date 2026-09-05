import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";

import { usePlanEventsBridge } from "../lib/plan-events.js";
import { useResolvedTheme } from "../lib/preferences.js";
import { Header } from "./header.js";
import { PageBoundary } from "./page-boundary.js";
import { Sidebar } from "./sidebar.js";

export function AppShell() {
  const theme = useResolvedTheme();
  const location = useLocation();
  const isDocumentation = location.pathname === "/docs" || location.pathname.startsWith("/docs/");
  const isExtension = location.pathname === "/extensions" || location.pathname.startsWith("/extensions/");
  usePlanEventsBridge();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <div
      className={`flex h-full flex-col overflow-hidden bg-bg text-text ${isDocumentation || isExtension ? "min-w-0" : "min-w-[720px]"} ${isExtension ? "extension-shell" : ""}`}
    >
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className={`relative min-w-0 flex-1 ${isExtension ? "overflow-auto" : "overflow-hidden"}`}>
          <PageBoundary>
            <Outlet />
          </PageBoundary>
        </main>
      </div>
    </div>
  );
}
