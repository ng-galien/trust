import {
  compileProcedure,
  type CompiledProcedure,
  type ProcedureCompilationInput,
} from "@trust/procedure";

import type { Clock } from "../time.js";
import type { OperationCatalog } from "../operation/catalog.js";
import {
  ProcedureStore,
  type PublishedProcedure,
} from "./store.js";

export type ProcedureSource = Omit<ProcedureCompilationInput, "operations">;

export interface ProceduresDependencies {
  readonly clock: Clock;
  readonly operationCatalog: OperationCatalog;
  readonly procedureStore: ProcedureStore;
}

export class Procedures {
  readonly #clock: Clock;
  readonly #operations: OperationCatalog;
  readonly #store: ProcedureStore;

  constructor({ clock, operationCatalog, procedureStore }: ProceduresDependencies) {
    this.#clock = clock;
    this.#operations = operationCatalog;
    this.#store = procedureStore;
  }

  compile(input: ProcedureSource): CompiledProcedure {
    return compileProcedure({ ...input, operations: this.#operations.list() });
  }

  async publish(input: ProcedureSource, publisher: string): Promise<PublishedProcedure> {
    const procedure = this.compile(input);
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

  async findOperation(
    operation: string,
    digest: string,
  ): Promise<{ readonly operation: string; readonly digest: string } | undefined> {
    return this.#store.findOperation(operation, digest);
  }
}
