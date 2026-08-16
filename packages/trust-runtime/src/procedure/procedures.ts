import {
  compileProcedure,
  type CompiledProcedure,
  type ProcedureCompilationInput,
} from "@trust/procedure";

import type { Clock } from "../time.js";
import {
  ProcedureStore,
  type PublishedProcedure,
} from "./store.js";

export type ProcedureSource = Omit<ProcedureCompilationInput, "operations">;

export interface ProceduresDependencies {
  readonly clock: Clock;
  readonly operations: ProcedureCompilationInput["operations"];
  readonly procedureStore: ProcedureStore;
}

export class Procedures {
  readonly #clock: Clock;
  readonly #operations: ProcedureCompilationInput["operations"];
  readonly #store: ProcedureStore;

  constructor({ clock, operations, procedureStore }: ProceduresDependencies) {
    this.#clock = clock;
    this.#operations = operations;
    this.#store = procedureStore;
  }

  compile(input: ProcedureSource): CompiledProcedure {
    return compileProcedure({ ...input, operations: this.#operations });
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
