import type {
  RegistryPackageDeclaration,
  RegistryPackageIndex,
  RegistrySource,
  RegistrySourceInput,
} from "@trust/extension-sdk";
import type { Selectable } from "kysely";

import type { Database, RegistrySourceTable } from "../database/database.js";

type RegistrySourceRow = Selectable<RegistrySourceTable>;

/** The last explicitly refreshed index of one source. */
export interface StoredRegistryIndex {
  readonly source: string;
  readonly revision: string;
  readonly index: RegistryPackageIndex;
  readonly refreshedAt: string;
}

/** One installed package; its declaration is the exact index entry that was installed. */
export interface StoredRegistryPackage {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly revision: string;
  readonly directory: string;
  readonly declaration: RegistryPackageDeclaration;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export class RegistrySourceStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  async list(): Promise<RegistrySource[]> {
    const rows = await this.dependencies.database.selectFrom("registry_sources").selectAll().orderBy("name").execute();
    return rows.map(toRegistrySource);
  }

  async find(name: string): Promise<RegistrySource | undefined> {
    const row = await this.dependencies.database
      .selectFrom("registry_sources")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirst();
    return row === undefined ? undefined : toRegistrySource(row);
  }

  /** A changed location invalidates the last refreshed index; an identical save keeps it. */
  async save(source: RegistrySourceInput, updatedAt: string): Promise<RegistrySource> {
    const reference = source.kind === "git" ? (source.reference ?? null) : null;
    await this.dependencies.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("registry_sources")
        .selectAll()
        .where("name", "=", source.name)
        .executeTakeFirst();
      if (
        existing !== undefined &&
        (existing.kind !== source.kind || existing.url !== source.url || existing.reference !== reference)
      )
        await transaction.deleteFrom("registry_source_indexes").where("source_name", "=", source.name).execute();
      await transaction
        .insertInto("registry_sources")
        .values({
          name: source.name,
          kind: source.kind,
          url: source.url,
          reference,
          created_at: updatedAt,
          updated_at: updatedAt,
        })
        .onConflict((conflict) =>
          conflict.column("name").doUpdateSet({ kind: source.kind, url: source.url, reference, updated_at: updatedAt }),
        )
        .execute();
    });
    const saved = await this.find(source.name);
    if (saved === undefined) throw new Error(`Registry source ${source.name} cannot be read back`);
    return saved;
  }

  /** Removes the source and its refreshed index; installed packages are not touched. */
  async remove(name: string): Promise<boolean> {
    const result = await this.dependencies.database
      .deleteFrom("registry_sources")
      .where("name", "=", name)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async index(name: string): Promise<StoredRegistryIndex | undefined> {
    const row = await this.dependencies.database
      .selectFrom("registry_source_indexes")
      .selectAll()
      .where("source_name", "=", name)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { source: row.source_name, revision: row.revision, index: row.index_json, refreshedAt: row.refreshed_at };
  }

  async saveIndex(value: StoredRegistryIndex): Promise<void> {
    const values = {
      revision: value.revision,
      index_json: JSON.stringify(value.index),
      refreshed_at: value.refreshedAt,
    };
    await this.dependencies.database
      .insertInto("registry_source_indexes")
      .values({ source_name: value.source, ...values })
      .onConflict((conflict) => conflict.column("source_name").doUpdateSet(values))
      .execute();
  }

  async packages(): Promise<StoredRegistryPackage[]> {
    const rows = await this.dependencies.database
      .selectFrom("registry_packages")
      .selectAll()
      .orderBy("package_name")
      .execute();
    return rows.map((row) => ({
      name: row.package_name,
      version: row.version,
      source: row.source_name,
      revision: row.revision,
      directory: row.directory,
      declaration: row.declaration_json,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
    }));
  }

  async package(name: string): Promise<StoredRegistryPackage | undefined> {
    return (await this.packages()).find((value) => value.name === name);
  }

  async savePackage(value: StoredRegistryPackage): Promise<void> {
    const values = {
      version: value.version,
      source_name: value.source,
      revision: value.revision,
      directory: value.directory,
      declaration_json: JSON.stringify(value.declaration),
      updated_at: value.updatedAt,
    };
    await this.dependencies.database
      .insertInto("registry_packages")
      .values({ package_name: value.name, installed_at: value.installedAt, ...values })
      .onConflict((conflict) => conflict.column("package_name").doUpdateSet(values))
      .execute();
  }

  async removePackage(name: string): Promise<void> {
    await this.dependencies.database.deleteFrom("registry_packages").where("package_name", "=", name).execute();
  }
}

function toRegistrySource(row: RegistrySourceRow): RegistrySource {
  const common = {
    name: row.name,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return row.kind === "git"
    ? { ...common, kind: "git", ...(row.reference === null ? {} : { reference: row.reference }) }
    : { ...common, kind: row.kind };
}
