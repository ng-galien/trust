import type { RegistryCatalogImportEntry } from "@trust/extension-sdk";
import { type CompiledOperation, compileOperation } from "@trust/operation";
import type { CompiledProcedure } from "@trust/procedure";

import type { OperationCatalog } from "../operation/catalog.js";
import type { Procedures } from "../procedure/procedures.js";
import { RegistryError } from "./error.js";

export interface CatalogArtifact {
  readonly kind: "operation" | "procedure";
  /** Label reported in errors: the declared content path. */
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly source: string;
  /** Stored Operation file name. */
  readonly sourceName?: string;
}

export interface PreparedCatalogImport {
  readonly entries: readonly RegistryCatalogImportEntry[];
  /** Operations before Procedures; published versions are never replaced. */
  apply(publisher: string): Promise<{ readonly imported: number; readonly unchanged: number }>;
}

/**
 * Validate a complete batch against the current catalog before anything is stored. With `sameSourceOnly`, an
 * identical Operation stored under another file name is a conflict (registry synchronization); otherwise an
 * identical published definition is simply unchanged (packages may share an Operation).
 */
export async function prepareCatalogImport(
  dependencies: { readonly operationCatalog: OperationCatalog; readonly procedures: Procedures },
  artifacts: readonly CatalogArtifact[],
  sameSourceOnly: boolean,
): Promise<PreparedCatalogImport> {
  // Prevalidate against current disk state, not a runtime's startup cache.
  await dependencies.operationCatalog.initialize();
  const operations = artifacts
    .filter((artifact) => artifact.kind === "operation")
    .map((artifact) => {
      const sourceName = artifact.sourceName ?? `registry-${artifact.name}-${artifact.version}.feature`;
      let compiled: CompiledOperation;
      try {
        compiled = compileOperation({ source: artifact.source, sourceName });
      } catch (error) {
        throw new RegistryError(
          "import-rejected",
          `Operation artifact ${artifact.path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
          artifact.path,
        );
      }
      assertIdentity(artifact, compiled.operation, compiled.version);
      const existing = dependencies.operationCatalog.entry(compiled.operation, compiled.version);
      if (existing !== undefined && sameSourceOnly && existing.sourceName !== sourceName) {
        throw new RegistryError(
          "artifact-conflict",
          `Operation ${compiled.operation}@${compiled.version} is already stored by another source`,
          artifact.path,
        );
      }
      if (existing !== undefined && existing.operation.source !== compiled.source) {
        throw new RegistryError(
          "artifact-conflict",
          `Operation ${compiled.operation}@${compiled.version} is already published with another definition`,
          artifact.path,
        );
      }
      return { artifact, sourceName, compiled, status: existing === undefined ? "imported" : "unchanged" } as const;
    });
  const importedIdentities = new Set(operations.map(({ compiled }) => `${compiled.operation}@${compiled.version}`));
  const futureOperations = [
    ...dependencies.operationCatalog
      .list()
      .filter((operation) => !importedIdentities.has(`${operation.operation}@${operation.version}`)),
    ...operations.map(({ compiled }) => compiled),
  ];
  const procedures = await Promise.all(
    artifacts
      .filter((artifact) => artifact.kind === "procedure")
      .map(async (artifact) => {
        let compiled: CompiledProcedure;
        try {
          compiled = await dependencies.procedures.compile(
            { source: artifact.source, sourceName: artifact.path },
            futureOperations,
          );
        } catch (error) {
          throw new RegistryError(
            "import-rejected",
            `Procedure artifact ${artifact.path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
            artifact.path,
          );
        }
        assertIdentity(artifact, compiled.procedure, compiled.version);
        const existing = await dependencies.procedures.find(compiled.procedure, compiled.version);
        if (
          existing !== undefined &&
          (existing.procedure.definitionDigest !== compiled.definitionDigest ||
            existing.procedure.source !== compiled.source)
        ) {
          throw new RegistryError(
            "artifact-conflict",
            `Procedure ${compiled.procedure}@${compiled.version} is already published with another definition`,
            artifact.path,
          );
        }
        return { artifact, status: existing === undefined ? "imported" : "unchanged" } as const;
      }),
  );
  const entries: RegistryCatalogImportEntry[] = [
    ...operations.map(({ artifact, status }) => ({
      kind: "operation" as const,
      name: artifact.name,
      version: artifact.version,
      status,
    })),
    ...procedures.map(({ artifact, status }) => ({
      kind: "procedure" as const,
      name: artifact.name,
      version: artifact.version,
      status,
    })),
  ];
  const unchanged = entries.filter(({ status }) => status === "unchanged").length;
  return {
    entries,
    async apply(publisher) {
      let imported = 0;
      try {
        for (const { artifact, sourceName, status } of operations) {
          if (status === "unchanged") continue;
          await dependencies.operationCatalog.save(artifact.source, sourceName);
          imported += 1;
        }
        for (const { artifact, status } of procedures) {
          if (status === "unchanged") continue;
          await dependencies.procedures.publish({ source: artifact.source, sourceName: artifact.path }, publisher);
          imported += 1;
        }
      } catch (error) {
        if (error instanceof RegistryError) throw error;
        throw new RegistryError(
          "import-rejected",
          `The catalog import could not be completed: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { imported, unchanged, failed: 1 },
          "catalog",
        );
      }
      return { imported, unchanged };
    },
  };
}

function assertIdentity(artifact: CatalogArtifact, actualName: string, actualVersion: string): void {
  if (actualName !== artifact.name || actualVersion !== artifact.version) {
    throw new RegistryError(
      "artifact-identity-mismatch",
      `Artifact ${artifact.path} declares ${actualName}@${actualVersion}; expected ${artifact.name}@${artifact.version}`,
      artifact.path,
    );
  }
}
