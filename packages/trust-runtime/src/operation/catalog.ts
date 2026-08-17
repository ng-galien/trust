import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { compileOperation, type CompiledOperation } from "@trust/operation";

interface CatalogEntry {
  readonly sourceName: string;
  readonly operation: CompiledOperation;
}

export type OperationCatalogErrorCode = "catalog-read-only" | "invalid-source-name" | "operation-conflict" | "unknown-operation";

export class OperationCatalogError extends Error {
  constructor(readonly reason: OperationCatalogErrorCode, message: string) {
    super(message);
    this.name = "OperationCatalogError";
  }
}

export interface OperationCatalogDependencies {
  readonly operations: readonly CompiledOperation[];
  readonly operationsDirectory?: string;
}

export class OperationCatalog {
  readonly #directory: string | undefined;
  #entries: CatalogEntry[];
  #mutations: Promise<void> = Promise.resolve();

  constructor({ operations, operationsDirectory }: OperationCatalogDependencies) {
    this.#directory = operationsDirectory;
    this.#entries = operations.map((operation) => ({
      sourceName: `${operation.operation}.feature`,
      operation,
    }));
  }

  async initialize(): Promise<void> {
    if (this.#directory !== undefined) {
      await this.#serialize(async () => {
        this.#entries = await readEntries(this.#directory!);
      });
    }
  }

  list(): readonly CompiledOperation[] {
    return this.#entries.map((entry) => entry.operation);
  }

  find(operation: string, version: string): CompiledOperation | undefined {
    return this.#entries.find((entry) => entry.operation.operation === operation && entry.operation.version === version)?.operation;
  }

  async save(source: string, sourceName: string): Promise<CompiledOperation> {
    return this.#serialize(async () => {
      const directory = this.#writableDirectory();
      validateSourceName(sourceName);
      const compiled = compileOperation({ source, sourceName });
      const conflict = this.#entries.find((entry) => entry.operation.operation === compiled.operation
        && entry.operation.version === compiled.version && entry.sourceName !== sourceName);
      if (conflict !== undefined) {
        throw new OperationCatalogError(
          "operation-conflict",
          `Operation ${compiled.operation}@${compiled.version} is already stored in ${conflict.sourceName}`,
        );
      }
      await mkdir(directory, { recursive: true });
      const target = resolve(directory, sourceName);
      const temporary = resolve(directory, `.${sourceName}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, source, "utf8");
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      this.#entries = await readEntries(directory);
      const saved = this.find(compiled.operation, compiled.version);
      if (!saved || saved.source !== compiled.source) {
        throw new Error(`Saved Operation ${compiled.operation}@${compiled.version} cannot be read back`);
      }
      return saved;
    });
  }

  async remove(operation: string, version: string): Promise<void> {
    await this.#serialize(async () => {
      const directory = this.#writableDirectory();
      const entry = this.#entries.find((candidate) => candidate.operation.operation === operation
        && candidate.operation.version === version);
      if (!entry) throw new OperationCatalogError("unknown-operation", `Operation ${operation}@${version} is not in the catalog`);
      await unlink(resolve(directory, entry.sourceName));
      this.#entries = await readEntries(directory);
    });
  }

  #writableDirectory(): string {
    if (this.#directory === undefined) {
      throw new OperationCatalogError("catalog-read-only", "The Operation catalog has no configured source directory");
    }
    return this.#directory;
  }

  #serialize<Result>(mutation: () => Promise<Result>): Promise<Result> {
    const result = this.#mutations.then(mutation, mutation);
    this.#mutations = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function readEntries(directory: string): Promise<CatalogEntry[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".feature")).sort();
  const entries = await Promise.all(names.map(async (sourceName) => ({
    sourceName,
    operation: compileOperation({ source: await readFile(resolve(directory, sourceName), "utf8"), sourceName }),
  })));
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.operation.operation}@${entry.operation.version}`;
    if (identities.has(identity)) throw new OperationCatalogError("operation-conflict", `Operation ${identity} is declared more than once`);
    identities.add(identity);
  }
  return entries;
}

function validateSourceName(sourceName: string): void {
  if (sourceName.length === 0 || sourceName.length > 255 || basename(sourceName) !== sourceName || !sourceName.endsWith(".feature")) {
    throw new OperationCatalogError("invalid-source-name", "Operation sourceName must be one .feature file name");
  }
}
