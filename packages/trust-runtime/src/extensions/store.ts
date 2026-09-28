import type { ExtensionCapability, ExtensionSettingsValues } from "@trust/extension-sdk";
import type { Database } from "../database/database.js";

export interface StoredExtensionInstallation {
  readonly id: string;
  readonly manifest: string;
  readonly environment: string;
  readonly grants: ExtensionCapability[];
  readonly credentialEnvironment: string[];
  readonly autoStart: boolean;
}
export interface StoredExtensionSettings {
  readonly values: ExtensionSettingsValues;
  readonly revision: number;
}

/** Installation records and settings values owned by the runtime database; never extension data. */
export class ExtensionInstallationStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  async installations(): Promise<StoredExtensionInstallation[]> {
    const rows = await this.dependencies.database
      .selectFrom("extension_installations")
      .selectAll()
      .orderBy("installation_id")
      .execute();
    return rows.map((row) => ({
      id: row.installation_id,
      manifest: row.manifest,
      environment: row.environment,
      grants: row.grants_json as ExtensionCapability[],
      credentialEnvironment: row.credential_environment_json,
      autoStart: row.auto_start,
    }));
  }

  async settings(id: string): Promise<StoredExtensionSettings | undefined> {
    const row = await this.dependencies.database
      .selectFrom("extension_settings")
      .select(["settings_json", "revision"])
      .where("installation_id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : { values: row.settings_json, revision: row.revision };
  }

  /** Revision-checked write; returns false when another writer changed the revision first. */
  async saveSettings(
    id: string,
    values: ExtensionSettingsValues,
    expectedRevision: number,
    at: string,
  ): Promise<boolean> {
    const json = JSON.stringify(values);
    if (expectedRevision === 0) {
      const inserted = await this.dependencies.database
        .insertInto("extension_settings")
        .values({ installation_id: id, settings_json: json, revision: 1, updated_at: at })
        .onConflict((conflict) => conflict.column("installation_id").doNothing())
        .executeTakeFirst();
      return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
    }
    const updated = await this.dependencies.database
      .updateTable("extension_settings")
      .set({ settings_json: json, revision: expectedRevision + 1, updated_at: at })
      .where("installation_id", "=", id)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    return updated.numUpdatedRows > 0n;
  }

  async saveInstallation(installation: StoredExtensionInstallation, at: string): Promise<void> {
    const values = {
      manifest: installation.manifest,
      environment: installation.environment,
      grants_json: JSON.stringify(installation.grants),
      credential_environment_json: JSON.stringify(installation.credentialEnvironment),
      auto_start: installation.autoStart,
      updated_at: at,
    };
    await this.dependencies.database
      .insertInto("extension_installations")
      .values({ installation_id: installation.id, installed_at: at, ...values })
      .onConflict((conflict) => conflict.column("installation_id").doUpdateSet(values))
      .execute();
  }

  async removeInstallation(id: string): Promise<void> {
    await this.dependencies.database.transaction().execute(async (transaction) => {
      await transaction.deleteFrom("extension_settings").where("installation_id", "=", id).execute();
      await transaction.deleteFrom("extension_installations").where("installation_id", "=", id).execute();
    });
  }
}
