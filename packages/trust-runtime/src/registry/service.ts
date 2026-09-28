import { createHash } from "node:crypto";

import {
  REGISTRY_ARTIFACT_INDEX_CONTRACT,
  type RegistrySource,
  type RegistrySourceIndexView,
  type RegistrySourceInput,
  type RegistrySourceRemoval,
} from "@trust/extension-sdk";
import { matchRegistrySource } from "@trust/extension-sdk/match";

import type { OperationCatalog } from "../operation/catalog.js";
import type { Procedures } from "../procedure/procedures.js";
import type { Clock } from "../time.js";
import { type CatalogArtifact, prepareCatalogImport } from "./catalog-import.js";
import { RegistryError } from "./error.js";
import { availablePackage, parseArtifactIndex, parsePackageIndex } from "./package-index.js";
import { decodeUtf8, MAX_ARTIFACT_BYTES, openSource, sha256, validateName, validateSource } from "./source-reader.js";
import type { RegistrySourceStore } from "./store.js";

export interface RegistrySyncResult {
  readonly contract: "trust.registry-sync@1";
  readonly source: RegistrySource;
  readonly index: typeof REGISTRY_ARTIFACT_INDEX_CONTRACT;
  readonly artifacts: readonly {
    readonly kind: "operation" | "procedure";
    readonly name: string;
    readonly version: string;
    readonly status: "imported" | "unchanged";
  }[];
  readonly summary: { readonly imported: number; readonly unchanged: number; readonly failed: 0 };
}

export interface RegistryServiceDependencies {
  readonly registrySourceStore: RegistrySourceStore;
  readonly operationCatalog: OperationCatalog;
  readonly procedures: Procedures;
  readonly clock: Clock;
}

/** Named sources, `trust.registry-index@1` synchronization and explicit package index refresh. */
export class RegistryService {
  #synchronizations: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: RegistryServiceDependencies) {}

  list(): Promise<RegistrySource[]> {
    return this.dependencies.registrySourceStore.list();
  }

  async save(input: RegistrySourceInput): Promise<RegistrySource> {
    const source = validateSource(input);
    return this.dependencies.registrySourceStore.save(source, this.dependencies.clock.now().toISOString());
  }

  /** Removing a source never uninstalls a package installed from it. */
  async remove(name: string): Promise<RegistrySourceRemoval> {
    validateName(name);
    const keptPackages = (await this.dependencies.registrySourceStore.packages())
      .filter((installed) => installed.source === name)
      .map((installed) => installed.name);
    const removed = await this.dependencies.registrySourceStore.remove(name);
    return { contract: "trust.registry-source-removal@1", name, removed, keptPackages };
  }

  sync(name: string): Promise<RegistrySyncResult> {
    validateName(name);
    return this.#serialized(() => this.#synchronize(name));
  }

  /** Explicitly read the source index and record its availability; never installs or updates a package. */
  refresh(name: string): Promise<RegistrySourceIndexView> {
    validateName(name);
    return this.#serialized(async () => {
      const source = await this.#source(name);
      const reader = await openSource(source);
      try {
        const index = parsePackageIndex(reader.indexBytes);
        await this.dependencies.registrySourceStore.saveIndex({
          source: name,
          revision: reader.revision,
          index,
          refreshedAt: this.dependencies.clock.now().toISOString(),
        });
      } finally {
        await reader.close();
      }
      return this.read(name);
    });
  }

  /** The last refreshed index; never contacts the source. */
  async read(name: string): Promise<RegistrySourceIndexView> {
    validateName(name);
    const source = await this.#source(name);
    const stored = await this.dependencies.registrySourceStore.index(name);
    if (stored === undefined)
      throw new RegistryError("index-not-refreshed", `Registry source ${name} has not been refreshed yet`);
    const installed = new Map(
      (await this.dependencies.registrySourceStore.packages()).map((value) => [value.name, value.version]),
    );
    const locate = locator(source);
    return {
      contract: "trust.registry-source-index@1",
      source,
      revision: stored.revision,
      base: locate(stored.index.base === "." ? "" : stored.index.base) || ".",
      refreshedAt: stored.refreshedAt,
      packages: stored.index.packages.map((declaration) =>
        availablePackage(name, stored.index, declaration, locate, installed.get(declaration.name) ?? null),
      ),
    };
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#synchronizations.then(operation, operation);
    this.#synchronizations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #source(name: string): Promise<RegistrySource> {
    const source = await this.dependencies.registrySourceStore.find(name);
    if (source === undefined) throw new RegistryError("unknown-source", `Registry source ${name} does not exist`);
    return source;
  }

  async #synchronize(name: string): Promise<RegistrySyncResult> {
    const source = await this.#source(name);
    const reader = await openSource(source);
    let artifacts: CatalogArtifact[];
    try {
      const index = parseArtifactIndex(reader.indexBytes);
      artifacts = await Promise.all(
        index.artifacts.map(async (definition) => {
          const bytes = await reader.read(definition.path, MAX_ARTIFACT_BYTES);
          if (sha256(bytes) !== definition.sha256)
            throw new RegistryError(
              "artifact-integrity-mismatch",
              `Artifact ${definition.path} SHA-256 does not match the registry index`,
              definition.path,
            );
          return {
            kind: definition.kind,
            path: definition.path,
            name: definition.name,
            version: definition.version,
            source: decodeUtf8(bytes, definition.path),
            ...(definition.kind === "operation" ? { sourceName: operationSourceName(source.name, definition) } : {}),
          };
        }),
      );
    } finally {
      await reader.close();
    }
    const prepared = await prepareCatalogImport(this.dependencies, artifacts, true);
    const { imported, unchanged } = await prepared.apply(`registry:${source.name}`);
    return {
      contract: "trust.registry-sync@1",
      source,
      index: REGISTRY_ARTIFACT_INDEX_CONTRACT,
      artifacts: prepared.entries,
      summary: { imported, unchanged, failed: 0 },
    };
  }
}

/** Public location of a root-relative path, without opening the source. */
export function locator(source: RegistrySource): (path: string) => string {
  return matchRegistrySource<(path: string) => string>(source, {
    git: () => (path) => path,
    http:
      ({ url }) =>
      (path) =>
        new URL(path, url).toString(),
    file: ({ url }) => {
      const root = url.slice(0, url.lastIndexOf("/") + 1);
      return (path) => `${root}${path}`;
    },
  });
}

export function operationSourceName(scope: string, artifact: { name: string; version: string }): string {
  const digest = createHash("sha256")
    .update(`${scope}\0${artifact.name}\0${artifact.version}`)
    .digest("hex")
    .slice(0, 24);
  return `registry-${digest}.feature`;
}
