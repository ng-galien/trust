import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { StorageConfiguration } from "./database/storage.js";

/** One runtime owns one database. Selection never converts or replaces an existing database. */
export function storageFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): StorageConfiguration {
  if (environment.TRUST_DATABASE_PATH !== undefined) {
    throw new TypeError(
      "TRUST_DATABASE_PATH selected the retired SQLite backend. Preserve that database and use the explicit SQLite import command before selecting TRUST_STORAGE and its target.",
    );
  }
  const kind = environment.TRUST_STORAGE ?? "pglite";
  if (kind === "postgresql") {
    if (environment.TRUST_PGLITE_DIRECTORY !== undefined) {
      throw new TypeError("PostgreSQL storage cannot also select TRUST_PGLITE_DIRECTORY");
    }
    if (!environment.TRUST_DATABASE_URL?.trim()) {
      throw new TypeError("PostgreSQL storage requires TRUST_DATABASE_URL");
    }
    return { kind, connectionString: environment.TRUST_DATABASE_URL };
  }
  if (kind !== "pglite") throw new TypeError("TRUST_STORAGE must be pglite or postgresql");
  if (environment.TRUST_DATABASE_URL !== undefined) {
    throw new TypeError("TRUST_DATABASE_URL requires explicit TRUST_STORAGE=postgresql");
  }
  const directory = environment.TRUST_PGLITE_DIRECTORY;
  if (directory !== undefined && directory.trim().length === 0) {
    throw new TypeError("TRUST_PGLITE_DIRECTORY must not be empty");
  }
  if (directory === undefined && existsSync(resolve(".trust/trust.sqlite"))) {
    throw new Error(
      "An existing SQLite database requires explicit import; refusing to start an empty default database",
    );
  }
  return { kind, directory: resolve(directory ?? ".trust/pglite") };
}
