import {
  compileProcedure,
  type CompiledProcedure,
  type ProcedureCompilationInput,
} from "@trust/procedure";

import type { Clock } from "../time.js";
import {
  ProcedureStore,
  type PublishedProcedure,
} from "../sqlite/procedures.js";

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

  publish(input: ProcedureSource, publisher: string): PublishedProcedure {
    const procedure = this.compile(input);
    return this.#store.publish(
      procedure,
      input.sourceName ?? "<procedure>",
      publisher,
      this.#clock.now().toISOString(),
    );
  }

  find(procedure: string, version: string): PublishedProcedure | undefined {
    return this.#store.find(procedure, version);
  }

  list(): readonly PublishedProcedure[] {
    return this.#store.list();
  }

  findOperation(
    operation: string,
    digest: string,
  ): { readonly operation: string; readonly digest: string } | undefined {
    return this.#store.findOperation(operation, digest);
  }
}
