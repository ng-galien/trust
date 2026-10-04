import type { MissionDefinition, PublishedProcedure } from "@trust/extension-sdk";
import { normalizeGherkinSource } from "@trust/gherkin";
import type { CompiledOperation } from "@trust/operation";
import {
  CatalogProcedureCompilationError,
  type CompiledProcedure,
  compileProcedure,
  type ProcedureCompilationInput,
} from "@trust/procedure";
import type { OperationCatalog } from "../operation/catalog.js";
import type { Clock } from "../time.js";
import { pinnedVocabularies, type Vocabularies } from "../vocabulary/vocabularies.js";
import { resolveMissionDefinition } from "./mission-resolution.js";
import type { ProcedureStore } from "./store.js";

export type ProcedureSource = Omit<
  ProcedureCompilationInput,
  "operations" | "procedures" | "resolveProcedure" | "vocabularies"
>;

export interface ProceduresDependencies {
  readonly clock: Clock;
  readonly operationCatalog: OperationCatalog;
  readonly procedureStore: ProcedureStore;
  readonly vocabularies: Vocabularies;
}

export class Procedures {
  readonly #clock: Clock;
  readonly #operations: OperationCatalog;
  readonly #store: ProcedureStore;
  readonly #vocabularies: Vocabularies;

  constructor({ clock, operationCatalog, procedureStore, vocabularies }: ProceduresDependencies) {
    this.#clock = clock;
    this.#operations = operationCatalog;
    this.#store = procedureStore;
    this.#vocabularies = vocabularies;
  }

  async compile(
    input: ProcedureSource,
    operations: readonly CompiledOperation[] = this.#operations.list(),
  ): Promise<CompiledProcedure> {
    const procedures = (await this.#store.list()).map((published) => published.procedure);
    const vocabularies = await this.#vocabularies.catalog();
    return compileProcedure({ ...input, operations, procedures, vocabularies });
  }

  async publish(input: ProcedureSource, publisher: string): Promise<PublishedProcedure> {
    const source = normalizeGherkinSource(input.source);
    const existing = (await this.#store.list()).find((value) => value.procedure.source === source);
    if (existing) return existing;
    const procedure = await this.compile(input);
    return this.#store.publish(
      procedure,
      input.sourceName ?? "<procedure>",
      publisher,
      this.#clock.now().toISOString(),
    );
  }

  async find(procedure: string, version: string): Promise<PublishedProcedure | undefined> {
    return this.#store.find(procedure, version);
  }

  async list(): Promise<readonly PublishedProcedure[]> {
    return this.#store.list();
  }

  /** Resolve one accepted mission without publishing its inline definitions. */
  async resolveMission(definition: MissionDefinition): Promise<CompiledProcedure> {
    const operations = this.#operations.list();
    const procedures = (await this.#store.list()).map((value) => value.procedure);
    return resolveMissionDefinition(definition, operations, procedures, await this.#vocabularies.catalog());
  }

  /** Resolve once for a new root engagement. Published definitions are never rewritten. */
  async resolve(procedure: string, version: string): Promise<CompiledProcedure | undefined> {
    let operations: readonly CompiledOperation[];
    let procedures: readonly CompiledProcedure[];
    let after: readonly CompiledOperation[];
    // The file-backed Operation catalog is atomic but independent of the core database. Retry a
    // catalog read if it changed while the one-statement Procedure snapshot was read.
    do {
      operations = this.#operations.list();
      procedures = (await this.#store.list()).map((value) => value.procedure);
      after = this.#operations.list();
    } while (operations.length !== after.length || operations.some((operation, index) => operation !== after[index]));
    const vocabularies = await this.#vocabularies.catalog();
    const root = procedures.find((value) => value.procedure === procedure && value.version === version);
    if (!root) return undefined;
    const resolved = new Map<string, CompiledProcedure>();
    const visiting = new Set<string>();
    const resolve = (selected: CompiledProcedure): CompiledProcedure => {
      const identity = `${selected.procedure}@${selected.version}`;
      if (visiting.has(identity))
        throw new CatalogProcedureCompilationError(
          "dependency-cycle",
          `Procedure invocation cycle contains "${identity}"`,
          identity,
        );
      const cached = resolved.get(identity);
      if (cached) return cached;
      visiting.add(identity);
      const compiled = compileProcedure({
        source: selected.source,
        sourceName: identity,
        operations,
        procedures,
        vocabularies: pinnedVocabularies(selected, vocabularies),
        resolveProcedure: resolve,
      });
      visiting.delete(identity);
      resolved.set(identity, compiled);
      return compiled;
    };
    return resolve(root);
  }

  async findOperation(
    operation: string,
    digest: string,
  ): Promise<{ readonly operation: string; readonly digest: string } | undefined> {
    return this.#store.findOperation(operation, digest);
  }
}
