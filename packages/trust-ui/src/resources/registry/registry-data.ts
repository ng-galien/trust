import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ExtensionDescriptor,
  ExtensionSettingsIssue,
  ExtensionSettingsUpdateResult,
  ExtensionSettingsValues,
  ExtensionSettingsView,
  RegistryFailure,
  RegistryPackageCatalog,
  RegistryPackageInstallation,
  RegistryPackageInstallRequest,
  RegistryPackageUninstallation,
  RegistryPackageUninstallRequest,
  RegistryPackageUpdate,
  RegistryPackageUpdateRequest,
  RegistrySource,
  RegistrySourceIndexView,
  RegistrySourceInput,
  RegistrySourceRemoval,
} from "@trust/extension-sdk";

import { i18next } from "../../i18n/index.js";
import { authenticatedFetch } from "../../lib/authentication.js";
import { useRuntime } from "../../lib/runtime-context.js";
import { RuntimeError } from "../../runtime.js";

/* Registry reads and writes: RPC `registry.*` and the extension settings surface. Refreshing an index,
   installing, updating and uninstalling are distinct mutations; none of them implies another. */

const keys = {
  sources: ["registry.sources"] as const,
  index: (source: string) => ["registry.index", source] as const,
  packages: ["registry.packages"] as const,
  extensions: ["extensions"] as const,
  settings: (extension: string) => ["extension.settings", extension] as const,
};

/** The typed registry refusal carried by a runtime error, when there is one. */
export function registryFailure(error: unknown): RegistryFailure | undefined {
  if (!(error instanceof RuntimeError)) return undefined;
  const data = error.data as Partial<RegistryFailure> | undefined;
  return data?.contract === "trust.registry-error@1" ? (data as RegistryFailure) : undefined;
}

/** The runtime refused the request for lack of permission (RPC -32001 or HTTP 401/403). */
export function accessDenied(error: unknown): boolean {
  if (error instanceof RuntimeError) return error.code === -32001;
  return error instanceof ExtensionRequestError && (error.status === 401 || error.status === 403);
}

export function useRegistrySources() {
  const runtime = useRuntime();
  return useQuery({
    queryKey: keys.sources,
    queryFn: async () => (await runtime.call<{ sources: RegistrySource[] }>("registry.source.list")).sources,
  });
}

/** Last refreshed index of one source; `null` when the source was never refreshed. Never contacts the source. */
export function useRegistryIndex(source: string, enabled = true) {
  const runtime = useRuntime();
  return useQuery({
    queryKey: keys.index(source),
    enabled: enabled && source !== "",
    retry: false,
    queryFn: async (): Promise<RegistrySourceIndexView | null> => {
      try {
        return await runtime.call<RegistrySourceIndexView>("registry.source.read", { name: source });
      } catch (error) {
        if (registryFailure(error)?.reason === "index-not-refreshed") return null;
        throw error;
      }
    },
  });
}

export function useInstalledPackages() {
  const runtime = useRuntime();
  return useQuery({
    queryKey: keys.packages,
    queryFn: async () => (await runtime.call<RegistryPackageCatalog>("registry.package.list")).packages,
    refetchInterval: 5_000,
  });
}

function useRegistryInvalidation() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.sources }),
      queryClient.invalidateQueries({ queryKey: ["registry.index"] }),
      queryClient.invalidateQueries({ queryKey: keys.packages }),
      queryClient.invalidateQueries({ queryKey: keys.extensions }),
      queryClient.invalidateQueries({ queryKey: ["extension.settings"] }),
      queryClient.invalidateQueries({ queryKey: ["operation.catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["procedure.catalog"] }),
    ]);
}

export function useSaveSource() {
  const runtime = useRuntime();
  const invalidate = useRegistryInvalidation();
  return useMutation({
    mutationFn: async (source: RegistrySourceInput) =>
      (await runtime.call<{ source: RegistrySource }>("registry.source.save", { ...source })).source,
    onSuccess: invalidate,
  });
}

/** Rereads the source index only: no package is installed or updated. */
export function useRefreshIndex() {
  const runtime = useRuntime();
  const invalidate = useRegistryInvalidation();
  return useMutation({
    mutationFn: (source: string) => runtime.call<RegistrySourceIndexView>("registry.source.refresh", { name: source }),
    onSettled: invalidate,
  });
}

/** Removes the source configuration only: its installed packages stay installed. */
export function useRemoveSource() {
  const runtime = useRuntime();
  const invalidate = useRegistryInvalidation();
  return useMutation({
    mutationFn: (source: string) => runtime.call<RegistrySourceRemoval>("registry.source.remove", { name: source }),
    onSuccess: invalidate,
  });
}

export function useInstallPackage() {
  const runtime = useRuntime();
  const invalidate = useRegistryInvalidation();
  return useMutation({
    mutationFn: (request: RegistryPackageInstallRequest) =>
      runtime.call<RegistryPackageInstallation>("registry.package.install", { ...request }),
    onSettled: invalidate,
  });
}

export function useUpdatePackage() {
  const runtime = useRuntime();
  const invalidate = useRegistryInvalidation();
  return useMutation({
    mutationFn: (request: RegistryPackageUpdateRequest) =>
      runtime.call<RegistryPackageUpdate>("registry.package.update", { ...request }),
    onSettled: invalidate,
  });
}

export function useUninstallPackage() {
  const runtime = useRuntime();
  const invalidate = useRegistryInvalidation();
  return useMutation({
    mutationFn: (request: RegistryPackageUninstallRequest) =>
      runtime.call<RegistryPackageUninstallation>("registry.package.uninstall", { ...request }),
    onSettled: invalidate,
  });
}

/** Extension surface refusal; settings refusals carry every validation issue. */
export class ExtensionRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly issues: readonly ExtensionSettingsIssue[] = [],
  ) {
    super(message);
    this.name = "ExtensionRequestError";
  }
}

async function extensionRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, init);
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; issues?: ExtensionSettingsIssue[] };
  };
  if (!response.ok)
    throw new ExtensionRequestError(
      body.error?.message ?? i18next.t("registry.failure.http", { status: String(response.status) }),
      body.error?.code ?? "extension-request-failed",
      response.status,
      body.error?.issues ?? [],
    );
  return body as T;
}

export function useExtensionSettings(extension: string) {
  const { baseUrl } = useRuntime();
  return useQuery({
    queryKey: keys.settings(extension),
    enabled: extension !== "",
    retry: false,
    queryFn: async () =>
      (
        await extensionRequest<{ settings: ExtensionSettingsView }>(
          `${baseUrl}/extensions/${encodeURIComponent(extension)}/settings`,
        )
      ).settings,
  });
}

export function useUpdateExtensionSettings(extension: string) {
  const { baseUrl } = useRuntime();
  const invalidate = useRegistryInvalidation();
  return useMutation({
    mutationFn: (input: { expectedRevision: number; settings: ExtensionSettingsValues }) =>
      extensionRequest<ExtensionSettingsUpdateResult>(
        `${baseUrl}/extensions/${encodeURIComponent(extension)}/settings`,
        { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
      ),
    onSuccess: invalidate,
  });
}

export type LifecycleAction = "prepare" | "start" | "restart" | "stop";

/** Explicit lifecycle transition of one installed extension; restart is stop then start. */
export function useExtensionTransition() {
  const { baseUrl } = useRuntime();
  const invalidate = useRegistryInvalidation();
  const post = (extension: string, action: "prepare" | "start" | "stop") =>
    extensionRequest<{ extension: ExtensionDescriptor }>(
      `${baseUrl}/extensions/${encodeURIComponent(extension)}/${action}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
  return useMutation({
    mutationFn: async ({ extension, action }: { extension: string; title?: string; action: LifecycleAction }) => {
      if (action !== "restart") return post(extension, action);
      await post(extension, "stop");
      return post(extension, "start");
    },
    onSettled: invalidate,
  });
}
