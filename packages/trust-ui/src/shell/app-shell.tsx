import { useEffect } from "react";
import { Outlet } from "react-router";

import { usePlanEventsBridge } from "../lib/plan-events.js";
import { useResolvedTheme } from "../lib/preferences.js";
import { Header } from "./header.js";
import { Sidebar } from "./sidebar.js";

export function AppShell() {
  const theme = useResolvedTheme();
  usePlanEventsBridge();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-text">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
