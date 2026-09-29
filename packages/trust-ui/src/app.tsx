import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useMemo } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ExtensionPage } from "./extensions/extensions.js";
import { AuthenticationBoundary } from "./lib/authentication-boundary.js";
import { RuntimeContext } from "./lib/runtime-context.js";
import { EnvironmentOverlay, EnvironmentsHome } from "./resources/environments/environments-home.js";
import { HistoryHome } from "./resources/history/history-home.js";
import { OperationOverlay } from "./resources/operations/operation-overlay.js";
import { OperationsHome } from "./resources/operations/operations-home.js";
import { OverviewHome } from "./resources/overview/overview-home.js";
import { DelegationHome } from "./resources/plans/delegation-home.js";
import { PlanOverlay } from "./resources/plans/plan-overlay.js";
import { PlansHome } from "./resources/plans/plans-home.js";
import { ProcedureOverlay } from "./resources/procedures/procedure-overlay.js";
import { ProceduresHome } from "./resources/procedures/procedures-home.js";
import { AvailablePackagePage } from "./resources/registry/available-package-page.js";
import { InstalledExtensionsPage, RegistrySourcesPage } from "./resources/registry/extension-management.js";
import { ExtensionSettingsPage } from "./resources/registry/extension-settings-page.js";
import { InstalledPackagePage } from "./resources/registry/installed-package-page.js";
import { PackageUninstallPage } from "./resources/registry/package-uninstall-page.js";
import { PackageUpdatePage } from "./resources/registry/package-update-page.js";
import { SourceNewPage } from "./resources/registry/source-new.js";
import { SourcePage } from "./resources/registry/source-page.js";
import { SettingsHome } from "./resources/settings/settings-home.js";
import { TemplateOverlay } from "./resources/templates/template-overlay.js";
import { TemplatesHome } from "./resources/templates/templates-home.js";
import { TrustRuntimeClient } from "./runtime.js";
import { AppShell } from "./shell/app-shell.js";
import { LoadingState } from "./ui/states.js";

// The documentation (MDX pages, mermaid) is its own chunk, loaded on first visit.
const DocsArea = lazy(() => import("./docs/docs-area.js").then((module) => ({ default: module.DocsArea })));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 2_000 } } });

const clearSessionQueries = () => queryClient.clear();

export function TrustApplication({ runtimeUrl }: { runtimeUrl: string }) {
  const client = useMemo(() => new TrustRuntimeClient(runtimeUrl.replace(/\/$/, "")), [runtimeUrl]);
  return (
    <AuthenticationBoundary authentication={client.authentication} onSignedOut={clearSessionQueries}>
      <QueryClientProvider client={queryClient}>
        <RuntimeContext.Provider value={client}>
          <BrowserRouter>
            <Routes>
              <Route path="/mobile/:extension" element={<ExtensionPage bare />} />
              <Route element={<AppShell />}>
                <Route path="/overview" element={<OverviewHome />} />
                <Route path="/operations" element={<OperationsHome />}>
                  <Route path="new" element={<OperationOverlay mode="new" />} />
                  <Route path=":operation" element={<OperationOverlay />} />
                </Route>
                <Route path="/procedures" element={<ProceduresHome />}>
                  <Route path="new" element={<ProcedureOverlay mode="new" />} />
                  <Route path=":procedure" element={<ProcedureOverlay />} />
                </Route>
                <Route path="/environments" element={<EnvironmentsHome />}>
                  <Route path="new" element={<EnvironmentOverlay mode="new" />} />
                  <Route path=":environment" element={<EnvironmentOverlay />} />
                </Route>
                <Route path="/plans" element={<PlansHome mode="live" />}>
                  <Route path="new" element={<PlanOverlay planMode="live" mode="new" />} />
                  <Route path=":plan" element={<PlanOverlay planMode="live" />} />
                </Route>
                <Route path="/dry-runs" element={<PlansHome mode="dry-run" />}>
                  <Route path="new" element={<PlanOverlay planMode="dry-run" mode="new" />} />
                  <Route path=":plan" element={<PlanOverlay planMode="dry-run" />} />
                </Route>
                <Route path="/checklists" element={<Navigate to="/plans" replace />} />
                <Route path="/delegation" element={<DelegationHome />} />
                <Route path="/history" element={<HistoryHome />} />
                <Route path="/templates" element={<TemplatesHome />}>
                  <Route path="new" element={<TemplateOverlay mode="new" />} />
                  <Route path=":template" element={<TemplateOverlay />} />
                </Route>
                <Route path="/settings" element={<SettingsHome />} />
                <Route path="/extensions" element={<InstalledExtensionsPage />} />
                <Route path="/extensions/sources" element={<RegistrySourcesPage />} />
                <Route path="/extensions/sources/new" element={<SourceNewPage />} />
                <Route path="/extensions/sources/:source" element={<SourcePage />} />
                <Route
                  path="/extensions/sources/:source/packages/:package/:version"
                  element={<AvailablePackagePage />}
                />
                <Route path="/extensions/packages/:package" element={<InstalledPackagePage />} />
                <Route path="/extensions/packages/:package/update" element={<PackageUpdatePage />} />
                <Route path="/extensions/packages/:package/uninstall" element={<PackageUninstallPage />} />
                <Route path="/extensions/settings/:extension" element={<ExtensionSettingsPage />} />
                <Route path="/extensions/:extension" element={<ExtensionPage />} />
                <Route
                  path="/docs/*"
                  element={
                    <Suspense fallback={<LoadingState />}>
                      <DocsArea />
                    </Suspense>
                  }
                />
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </RuntimeContext.Provider>
      </QueryClientProvider>
    </AuthenticationBoundary>
  );
}
