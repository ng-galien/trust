import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import {
  type ExtensionDescriptor,
  type ExtensionReplacementResult,
  type ExtensionSettingsValues,
  formatExtensionSettingsIssues,
  type RegistryCatalogImportEntry,
  type RegistryExtensionDeclaration,
  type RegistryInstallationSteps,
  type RegistryInstalledPackage,
  type RegistryPackageCatalog,
  type RegistryPackageDeclaration,
  type RegistryPackageInstallation,
  type RegistryPackageInstallRequest,
  type RegistryPackageItem,
  type RegistryPackageUninstallation,
  type RegistryPackageUninstallRequest,
  type RegistryPackageUpdate,
  type RegistryPackageUpdateRequest,
  type RegistrySource,
  type RegistryStep,
  validateExtensionSettings,
} from "@trust/extension-sdk";
import { compareVersions } from "@trust/operation/version";

import { ExtensionError, type ExtensionHost } from "../extensions/host.js";
import { installationOf, readManifest } from "../extensions/manifest.js";
import type { OperationCatalog } from "../operation/catalog.js";
import type { Procedures } from "../procedure/procedures.js";
import type { Clock } from "../time.js";
import { buildExtension } from "./build.js";
import { type CatalogArtifact, type PreparedCatalogImport, prepareCatalogImport } from "./catalog-import.js";
import { RegistryError } from "./error.js";
import { buildRequired, categoriesOf, contentPaths, rootPath } from "./package-index.js";
import { operationSourceName } from "./service.js";
import { decodeUtf8, MAX_ARTIFACT_BYTES, openSource, sha256 } from "./source-reader.js";
import type { RegistrySourceStore, StoredRegistryIndex, StoredRegistryPackage } from "./store.js";

export interface RegistryPackagesDependencies {
  readonly registrySourceStore: RegistrySourceStore;
  readonly operationCatalog: OperationCatalog;
  readonly procedures: Procedures;
  readonly extensionHost: ExtensionHost;
  readonly clock: Clock;
  readonly packagesDirectory: string;
}

interface StagedPackage {
  readonly directory: string;
  readonly revision: string;
  readonly built: boolean;
  readonly catalog: PreparedCatalogImport;
}

const IMMUTABLE = "published versions are immutable and may be referenced by Plans";

/**
 * Installed registry packages under `<packages directory>/<name>/<version>`. Every change is explicit and
 * serialized: acquisition of the pinned revision, digest and identity verification, build of extension code only,
 * atomic placement, catalog import (Operations before Procedures) and extension registration through the host.
 */
export class RegistryPackages {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: RegistryPackagesDependencies) {}

  async list(): Promise<RegistryPackageCatalog> {
    const packages = await this.dependencies.registrySourceStore.packages();
    return {
      contract: "trust.registry-package-catalog@1",
      packages: await Promise.all(packages.map((p) => this.#view(p))),
    };
  }

  install(request: RegistryPackageInstallRequest): Promise<RegistryPackageInstallation> {
    return this.#serialized(async () => {
      const store = this.dependencies.registrySourceStore;
      const { source, index } = await this.#available(request.source);
      const declaration = this.#declaration(index, request.package, request.version);
      if (await store.package(request.package))
        throw new RegistryError(
          "package-already-installed",
          `Package ${request.package} is already installed; update it explicitly`,
        );
      const extension = declaration.extension;
      if (extension && request.extension === undefined)
        throw new RegistryError(
          "invalid-request",
          `Package ${request.package} contains extension code: extension installation values are required`,
        );
      if (!extension && request.extension !== undefined)
        throw new RegistryError("invalid-request", `Package ${request.package} contains no extension code`);
      if (extension && this.dependencies.extensionHost.list().some((value) => value.installation.id === extension.name))
        throw new RegistryError(
          "extension-rejected",
          `Extension ${extension.name} is already installed`,
          undefined,
          undefined,
          "verification",
        );
      const values = request.extension;
      const installation = values && {
        environment: values.environment,
        grants: values.grants ?? [],
        credentialEnvironment: values.credentialEnvironment ?? [],
        autoStart: values.autoStart ?? false,
      };
      const staged = await this.#stage(source, index, declaration, async (manifestFile) => {
        if (!installation) return;
        const manifest = await this.#manifest(manifestFile);
        const settings = this.#settings(manifest.settingsSchema, values?.settings ?? {});
        guarded("extension-rejected", "verification", () => installationOf(manifest, { ...installation, settings }));
      });
      const directory = await this.#place(staged.directory, declaration);
      const catalog = await this.#importCatalog(staged.catalog, declaration, directory);
      let descriptor: ExtensionDescriptor | null = null;
      if (extension && installation) {
        try {
          descriptor = await this.dependencies.extensionHost.install({
            manifest: join(directory, ...extension.path.split("/")),
            ...installation,
            settings: values?.settings ?? {},
          });
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw extensionFailure(error, "extension");
        }
      }
      const at = this.dependencies.clock.now().toISOString();
      const stored: StoredRegistryPackage = {
        name: declaration.name,
        version: declaration.version,
        source: source.name,
        revision: staged.revision,
        directory,
        declaration,
        installedAt: at,
        updatedAt: at,
      };
      await store.savePackage(stored);
      return {
        contract: "trust.registry-package-installation@1",
        package: await this.#view(stored),
        steps: steps(staged.built, catalog.length > 0, extension !== undefined),
        catalog,
        extension: descriptor,
      };
    });
  }

  update(request: RegistryPackageUpdateRequest): Promise<RegistryPackageUpdate> {
    return this.#serialized(async () => {
      const store = this.dependencies.registrySourceStore;
      const host = this.dependencies.extensionHost;
      const current = await this.#installed(request.package);
      if (current.version === request.version)
        throw new RegistryError(
          "package-version-installed",
          `Package ${current.name}@${current.version} is already installed`,
        );
      const { source, index } = await this.#available(current.source);
      const declaration = this.#declaration(index, current.name, request.version);
      const previous = current.declaration.extension;
      const next = declaration.extension;
      if (!next && (request.settings !== undefined || request.grants !== undefined))
        throw new RegistryError(
          "invalid-request",
          `Package ${current.name}@${request.version} contains no extension code`,
        );
      if (next && (!previous || previous.name !== next.name))
        throw new RegistryError(
          "extension-rejected",
          `Package ${current.name}@${request.version} declares extension ${next.name}; install it as a new package instead`,
          undefined,
          undefined,
          "verification",
        );
      const instance = previous ? host.get(previous.name) : undefined;
      const previousSettings = previous ? (await host.readSettings(previous.name)).settings : {};
      const previousGrants = instance?.installation.grants ?? [];
      const staged = await this.#stage(source, index, declaration, async (manifestFile) => {
        if (!instance) return;
        const manifest = await this.#manifest(manifestFile);
        const settings = this.#settings(manifest.settingsSchema, request.settings ?? previousSettings);
        guarded("extension-rejected", "verification", () =>
          installationOf(manifest, {
            environment: instance.installation.environment,
            grants: request.grants ?? previousGrants,
            credentialEnvironment: instance.installation.credentialEnvironment,
            autoStart: instance.installation.autoStart,
            settings,
          }),
        );
      });
      const directory = await this.#place(staged.directory, declaration);
      let descriptor: ExtensionDescriptor | null = null;
      let preparationRequired = false;
      const removed: RegistryPackageItem[] = [];
      const restorePrevious = async (extension: RegistryExtensionDeclaration, start: boolean) => {
        await host
          .replace(extension.name, {
            manifest: join(current.directory, ...extension.path.split("/")),
            settings: previousSettings,
            grants: previousGrants,
          })
          .catch(() => undefined);
        if (start && host.get(extension.name).state !== "RUNNING")
          await host
            .get(extension.name)
            .transition("start")
            .catch(() => undefined);
      };
      const wasRunning = instance?.state === "RUNNING";
      if (previous && next) {
        let replaced: ExtensionReplacementResult;
        try {
          replaced = await host.replace(previous.name, {
            manifest: join(directory, ...next.path.split("/")),
            ...(request.settings === undefined ? {} : { settings: request.settings }),
            ...(request.grants === undefined ? {} : { grants: request.grants }),
          });
        } catch (error) {
          if (wasRunning && host.get(previous.name).state !== "RUNNING")
            await host
              .get(previous.name)
              .transition("start")
              .catch(() => undefined);
          await rm(directory, { recursive: true, force: true });
          throw extensionFailure(error, "extension");
        }
        if (wasRunning && replaced.extension.state !== "RUNNING" && !replaced.preparationRequired) {
          await restorePrevious(previous, true);
          await rm(directory, { recursive: true, force: true });
          throw new RegistryError(
            "extension-start-failed",
            `Extension ${next.name}@${next.version} did not start; version ${previous.version} was restored`,
            undefined,
            undefined,
            "extension",
          );
        }
        descriptor = replaced.extension;
        preparationRequired = replaced.preparationRequired;
      }
      let catalog: RegistryCatalogImportEntry[];
      try {
        catalog = await this.#importCatalog(staged.catalog, declaration, directory, false);
      } catch (error) {
        if (previous && next) await restorePrevious(previous, wasRunning);
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      if (previous && !next) {
        await host.remove(previous.name).catch((error: unknown) => {
          throw extensionFailure(error, "extension");
        });
        removed.push(
          { kind: "extension", name: previous.name, version: previous.version },
          { kind: "extension-settings", name: previous.name },
        );
      }
      const stored: StoredRegistryPackage = {
        ...current,
        version: declaration.version,
        revision: staged.revision,
        directory,
        declaration,
        updatedAt: this.dependencies.clock.now().toISOString(),
      };
      await store.savePackage(stored);
      await rm(current.directory, { recursive: true, force: true });
      removed.push({ kind: "files", name: current.directory, version: current.version });
      return {
        contract: "trust.registry-package-update@1",
        previousVersion: current.version,
        package: await this.#view(stored),
        steps: steps(staged.built, catalog.length > 0, next !== undefined),
        catalog,
        extension: descriptor,
        preparationRequired,
        removed,
      };
    });
  }

  uninstall(request: RegistryPackageUninstallRequest): Promise<RegistryPackageUninstallation> {
    return this.#serialized(async () => {
      const store = this.dependencies.registrySourceStore;
      const current = await this.#installed(request.package);
      const removed: RegistryPackageItem[] = [];
      const kept: RegistryPackageItem[] = [];
      const extension = current.declaration.extension;
      if (extension) {
        let dataDeleted: boolean;
        try {
          ({ dataDeleted } = await this.dependencies.extensionHost.remove(extension.name, {
            deleteData: request.deleteData === true,
          }));
        } catch (error) {
          throw extensionFailure(error, "uninstall");
        }
        removed.push(
          { kind: "extension", name: extension.name, version: extension.version },
          { kind: "extension-settings", name: extension.name },
        );
        (dataDeleted ? removed : kept).push({
          kind: "extension-data",
          name: extension.name,
          ...(dataDeleted ? {} : { reason: "data is deleted only on explicit request" }),
        });
      } else if (request.deleteData === true) {
        throw new RegistryError(
          "data-deletion-unsupported",
          `Package ${current.name} contains no extension code and owns no data`,
          undefined,
          undefined,
          "uninstall",
        );
      }
      await rm(current.directory, { recursive: true, force: true });
      await rmdir(dirname(current.directory)).catch(() => undefined);
      await store.removePackage(current.name);
      removed.push({ kind: "files", name: current.directory, version: current.version });
      for (const operation of current.declaration.operations ?? [])
        kept.push({ kind: "operation", name: operation.name, version: operation.version, reason: IMMUTABLE });
      for (const procedure of current.declaration.procedures ?? [])
        kept.push({ kind: "procedure", name: procedure.name, version: procedure.version, reason: IMMUTABLE });
      kept.push({ kind: "plans", name: "*", reason: "Plans and their history keep their pinned versions" });
      if (await store.find(current.source))
        kept.push({ kind: "source", name: current.source, reason: "removing a source is a separate action" });
      return {
        contract: "trust.registry-package-uninstallation@1",
        package: { name: current.name, version: current.version, source: current.source },
        removed,
        kept,
      };
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #installed(name: string): Promise<StoredRegistryPackage> {
    const installed = await this.dependencies.registrySourceStore.package(name);
    if (!installed) throw new RegistryError("package-not-installed", `Package ${name} is not installed`);
    return installed;
  }

  async #available(name: string): Promise<{ source: RegistrySource; index: StoredRegistryIndex }> {
    const source = await this.dependencies.registrySourceStore.find(name);
    if (!source) throw new RegistryError("unknown-source", `Registry source ${name} does not exist`);
    const index = await this.dependencies.registrySourceStore.index(name);
    if (!index) throw new RegistryError("index-not-refreshed", `Registry source ${name} has not been refreshed yet`);
    return { source, index };
  }

  #declaration(index: StoredRegistryIndex, name: string, version: string): RegistryPackageDeclaration {
    const declaration = index.index.packages.find((value) => value.name === name && value.version === version);
    if (!declaration)
      throw new RegistryError(
        "unknown-package",
        `Registry source ${index.source} does not offer ${name}@${version} in its last refreshed index`,
      );
    return declaration;
  }

  async #view(stored: StoredRegistryPackage): Promise<RegistryInstalledPackage> {
    const index = await this.dependencies.registrySourceStore.index(stored.source);
    const availableVersions = (index?.index.packages ?? [])
      .filter((value) => value.name === stored.name)
      .map((value) => value.version)
      .sort(compareVersions);
    const extension = stored.declaration.extension;
    return {
      name: stored.name,
      version: stored.version,
      source: stored.source,
      revision: stored.revision,
      directory: stored.directory,
      categories: categoriesOf(stored.declaration),
      extension: extension ? { id: extension.name, version: extension.version } : null,
      operations: (stored.declaration.operations ?? []).map(({ name, version }) => ({ name, version })),
      procedures: (stored.declaration.procedures ?? []).map(({ name, version }) => ({ name, version })),
      availableVersions,
      latestVersion: availableVersions.at(-1) ?? null,
      installedAt: stored.installedAt,
      updatedAt: stored.updatedAt,
    };
  }

  /**
   * Acquire, verify and build into a private staging directory under the packages directory. Nothing outside it
   * changes; any failure removes it.
   */
  async #stage(
    source: RegistrySource,
    index: StoredRegistryIndex,
    declaration: RegistryPackageDeclaration,
    validateExtension: (manifestFile: string) => Promise<void>,
  ): Promise<StagedPackage> {
    const staging = resolve(this.dependencies.packagesDirectory, ".staging");
    await mkdir(staging, { recursive: true });
    const directory = await mkdtemp(join(staging, `${declaration.name}-`));
    try {
      const reader = await openSource(source, source.kind === "git" ? index.revision : undefined);
      try {
        const expected = new Map<string, string>();
        const extension = declaration.extension;
        if (extension) {
          expected.set(extension.path, extension.sha256);
          for (const file of extension.files) expected.set(file.path, file.sha256);
        }
        for (const content of [...(declaration.operations ?? []), ...(declaration.procedures ?? [])])
          expected.set(content.path, content.sha256);
        for (const path of contentPaths(declaration)) {
          const bytes = await reader.read(rootPath(index.index.base, path), MAX_ARTIFACT_BYTES);
          if (sha256(bytes) !== expected.get(path))
            throw new RegistryError(
              "artifact-integrity-mismatch",
              `Artifact ${path} SHA-256 does not match the registry index`,
              path,
              undefined,
              "verification",
            );
          const target = join(directory, ...path.split("/"));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
        }
      } finally {
        await reader.close();
      }
      const extension = declaration.extension;
      if (extension) {
        let manifest: Record<string, unknown>;
        try {
          manifest = JSON.parse(
            decodeUtf8(await readFile(join(directory, ...extension.path.split("/"))), extension.path),
          ) as Record<string, unknown>;
        } catch {
          throw new RegistryError(
            "artifact-identity-mismatch",
            `Artifact ${extension.path} is not valid JSON`,
            extension.path,
            undefined,
            "verification",
          );
        }
        if (manifest.id !== extension.name || manifest.version !== extension.version)
          throw new RegistryError(
            "artifact-identity-mismatch",
            `Artifact ${extension.path} declares ${String(manifest.id)}@${String(manifest.version)}; expected ${extension.name}@${extension.version}`,
            extension.path,
            undefined,
            "verification",
          );
      }
      const built = buildRequired(declaration);
      if (built && extension) await buildExtension(join(directory, ...posix.dirname(extension.path).split("/")));
      const artifacts: CatalogArtifact[] = [];
      for (const [kind, contents] of [
        ["operation", declaration.operations ?? []],
        ["procedure", declaration.procedures ?? []],
      ] as const)
        for (const content of contents) {
          artifacts.push({
            kind,
            path: content.path,
            name: content.name,
            version: content.version,
            source: decodeUtf8(await readFile(join(directory, ...content.path.split("/"))), content.path),
            ...(kind === "operation"
              ? { sourceName: operationSourceName(`package:${declaration.name}`, content) }
              : {}),
          });
        }
      const catalog = await prepareCatalogImport(this.dependencies, artifacts, false).catch((error: unknown) => {
        if (error instanceof RegistryError && error.step === undefined)
          throw new RegistryError(error.reason, error.message, error.artifact, error.summary, "verification");
        throw error;
      });
      if (extension) await validateExtension(join(directory, ...extension.path.split("/")));
      return { directory, revision: index.revision, built, catalog };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Atomic rename into `<packages directory>/<name>/<version>`; a leftover unrecorded directory is replaced. */
  async #place(staged: string, declaration: RegistryPackageDeclaration): Promise<string> {
    const target = resolve(this.dependencies.packagesDirectory, declaration.name, declaration.version);
    try {
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      await rename(staged, target);
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw new RegistryError(
        "import-rejected",
        `Package ${declaration.name}@${declaration.version} could not be placed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        undefined,
        "placement",
      );
    }
    return target;
  }

  async #importCatalog(
    prepared: PreparedCatalogImport,
    declaration: RegistryPackageDeclaration,
    directory: string,
    removeOnFailure = true,
  ): Promise<RegistryCatalogImportEntry[]> {
    try {
      await prepared.apply(`registry-package:${declaration.name}@${declaration.version}`);
    } catch (error) {
      if (removeOnFailure) await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return [...prepared.entries];
  }

  async #manifest(manifestFile: string) {
    try {
      return await readManifest(manifestFile);
    } catch (error) {
      throw new RegistryError(
        "extension-rejected",
        `The extension manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        undefined,
        "verification",
      );
    }
  }

  #settings(schema: Parameters<typeof validateExtensionSettings>[0], settings: ExtensionSettingsValues) {
    const validation = validateExtensionSettings(schema, settings);
    if (!validation.valid)
      throw new RegistryError(
        "extension-rejected",
        formatExtensionSettingsIssues(validation.issues),
        undefined,
        undefined,
        "verification",
      );
    return validation.values;
  }
}

function steps(built: boolean, catalog: boolean, extension: boolean): RegistryInstallationSteps {
  return {
    acquisition: "completed",
    verification: "completed",
    build: built ? "completed" : "skipped",
    placement: "completed",
    catalog: catalog ? "completed" : "skipped",
    extension: extension ? "completed" : "skipped",
  };
}

function guarded<T>(reason: "extension-rejected", step: RegistryStep, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new RegistryError(reason, error instanceof Error ? error.message : String(error), undefined, undefined, step);
  }
}

function extensionFailure(error: unknown, step: RegistryStep): unknown {
  if (!(error instanceof ExtensionError)) return error;
  return new RegistryError(
    error.code === "extension-data-deletion-unsupported" ? "data-deletion-unsupported" : "extension-rejected",
    error.message,
    undefined,
    undefined,
    step,
  );
}
