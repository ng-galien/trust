import type { Database } from "../database/database.js";
import { EnvironmentConfigurationError } from "./validation.js";

export interface StoredEnvironment {
  readonly name: string;
  readonly values: Readonly<Record<string, string>>;
}

export class EnvironmentStore {
  constructor(private readonly dependencies: { readonly database: Database }) {}

  async list(): Promise<StoredEnvironment[]> {
    const [environments, variables] = await Promise.all([
      this.dependencies.database.selectFrom("environments").select("name").orderBy("name").execute(),
      this.dependencies.database
        .selectFrom("environment_variables")
        .select(["environment", "name", "value"])
        .orderBy("environment")
        .orderBy("name")
        .execute(),
    ]);
    return environments.map(({ name }) => ({
      name,
      values: Object.fromEntries(
        variables
          .filter((variable) => variable.environment === name)
          .map((variable) => [variable.name, variable.value]),
      ),
    }));
  }

  async save(name: string, values: Readonly<Record<string, string>>, updatedAt: string): Promise<void> {
    await this.dependencies.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("environments")
        .values({ name, created_at: updatedAt, updated_at: updatedAt })
        .onConflict((conflict) => conflict.column("name").doUpdateSet({ updated_at: updatedAt }))
        .execute();
      await transaction.deleteFrom("environment_variables").where("environment", "=", name).execute();
      const entries = Object.entries(values);
      if (entries.length > 0) {
        await transaction
          .insertInto("environment_variables")
          .values(
            entries.map(([variable, value]) => ({
              environment: name,
              name: variable,
              value,
              updated_at: updatedAt,
            })),
          )
          .execute();
      }
    });
  }

  async exists(name: string): Promise<boolean> {
    const environment = await this.dependencies.database
      .selectFrom("environments")
      .select("name")
      .where("name", "=", name)
      .executeTakeFirst();
    return environment !== undefined;
  }

  async remove(name: string, preserveCredentials = false): Promise<boolean> {
    return this.dependencies.database.transaction().execute(async (transaction) => {
      if (preserveCredentials) {
        const credential = await transaction
          .selectFrom("environment_credentials")
          .select("environment")
          .where("environment", "=", name)
          .executeTakeFirst();
        if (credential)
          throw new EnvironmentConfigurationError(
            "Environment has attached credentials. Remove them through the operator credential interface before removing the Environment.",
          );
      }
      const result = await transaction.deleteFrom("environments").where("name", "=", name).executeTakeFirst();
      return result.numDeletedRows > 0n;
    });
  }
}
