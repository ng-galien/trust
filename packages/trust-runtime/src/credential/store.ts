import type { Database } from "../database/database.js";

export interface StoredCredential {
  readonly environment: string;
  readonly name: string;
  readonly value: string;
}

export class CredentialStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  list(): Promise<StoredCredential[]> {
    return this.dependencies.database
      .selectFrom("environment_credentials")
      .select(["environment", "name", "value"])
      .orderBy("environment")
      .orderBy("name")
      .execute();
  }

  async save(environment: string, name: string, value: string, updatedAt: string): Promise<void> {
    await this.dependencies.database
      .insertInto("environment_credentials")
      .values({ environment, name, value, updated_at: updatedAt })
      .onConflict((conflict) => conflict
        .columns(["environment", "name"])
        .doUpdateSet({ value, updated_at: updatedAt }))
      .execute();
  }

  async remove(environment: string, name: string): Promise<boolean> {
    const result = await this.dependencies.database
      .deleteFrom("environment_credentials")
      .where("environment", "=", environment)
      .where("name", "=", name)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
