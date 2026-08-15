import {
  validateCompiledOperation,
  type CompiledOperation,
} from "@trust/operation";

import type { RuntimeJsonObject } from "../domain/runtime-model.js";

export interface ConfiguredExecution {
  readonly capability: string;
  readonly operation: CompiledOperation;
}

export interface ExecutionDefinitionServiceDependencies {
  readonly configuredExecutions: readonly ConfiguredExecution[];
  readonly executionEnvironments: Readonly<Record<string, RuntimeJsonObject>>;
}

export class ExecutionDefinitionService {
  readonly #operations: ReadonlyMap<string, CompiledOperation>;
  readonly #environments: Readonly<Record<string, RuntimeJsonObject>>;

  constructor({ configuredExecutions, executionEnvironments }: ExecutionDefinitionServiceDependencies) {
    const operations = new Map<string, CompiledOperation>();
    for (const configured of configuredExecutions) {
      if (configured.capability !== configured.operation.operation) {
        throw new TypeError(
          `Configured capability '${configured.capability}' does not match Operation '${configured.operation.operation}'.`,
        );
      }
      if (operations.has(configured.capability)) {
        throw new TypeError(`Operation capability '${configured.capability}' is repeated.`);
      }
      validateCompiledOperation(configured.operation);
      operations.set(configured.capability, configured.operation);
    }
    this.#operations = operations;
    this.#environments = executionEnvironments;
  }

  find(capability: string): CompiledOperation | undefined {
    return this.#operations.get(capability);
  }

  environment(name: string): RuntimeJsonObject | undefined {
    return this.#environments[name];
  }
}
