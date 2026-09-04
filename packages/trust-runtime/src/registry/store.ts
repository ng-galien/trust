import type { Selectable } from "kysely";

import type { Database, RegistrySourceTable } from "../database/database.js";

type RegistrySourceRow = Selectable<RegistrySourceTable>;

export type RegistrySource =
  | {
      readonly name: string;
      readonly kind: "git";
      readonly url: string;
      readonly reference?: string;
      readonly createdAt: string;
      readonly updatedAt: string;
    }
  | {
      readonly name: string;
      readonly kind: "http";
      readonly url: string;
      readonly createdAt: string;
      readonly updatedAt: string;
    };

export type RegistrySourceInput =
  | { readonly name: string; readonly kind: "git"; readonly url: string; readonly reference?: string }
  | { readonly name: string; readonly kind: "http"; readonly url: string };

export class RegistrySourceStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  async list(): Promise<RegistrySource[]> {
    const rows = await this.dependencies.database
      .selectFrom("registry_sources")
      .selectAll()
      .orderBy("name")
      .execute();
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

  async save(source: RegistrySourceInput, updatedAt: string): Promise<RegistrySource> {
    await this.dependencies.database
      .insertInto("registry_sources")
      .values({
        name: source.name,
        kind: source.kind,
        url: source.url,
        reference: source.kind === "git" ? source.reference ?? null : null,
        created_at: updatedAt,
        updated_at: updatedAt,
      })
      .onConflict((conflict) => conflict.column("name").doUpdateSet({
        kind: source.kind,
        url: source.url,
        reference: source.kind === "git" ? source.reference ?? null : null,
        updated_at: updatedAt,
      }))
      .execute();
    const saved = await this.find(source.name);
    if (saved === undefined) throw new Error(`Registry source ${source.name} cannot be read back`);
    return saved;
  }

  async remove(name: string): Promise<boolean> {
    const result = await this.dependencies.database
      .deleteFrom("registry_sources")
      .where("name", "=", name)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
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
    : { ...common, kind: "http" };
}
