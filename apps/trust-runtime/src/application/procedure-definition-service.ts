import type { Clock } from "../ports/clock.js";
import type {
  AutonomousProcedureDefinitionCompilationInput,
  CompiledAutonomousProcedureDefinition,
  CompiledRequiredCapability,
} from "@trust/procedure";
import { compileAutonomousProcedureDefinition } from "@trust/procedure";
import {
  ProcedureDefinitionRepository,
  type PublishedProcedureDefinition,
} from "../infrastructure/repositories/procedure-definition-repository.js";

export interface ProcedureDefinitionServiceDependencies {
  readonly clock: Clock;
  readonly procedureDefinitionRepository: ProcedureDefinitionRepository;
  readonly procedureDefinitionCompiler: typeof compileAutonomousProcedureDefinition;
}

export class ProcedureDefinitionService {
  readonly #clock: Clock;
  readonly #repository: ProcedureDefinitionRepository;
  readonly #compiler: typeof compileAutonomousProcedureDefinition;

  constructor({
    clock,
    procedureDefinitionRepository,
    procedureDefinitionCompiler,
  }: ProcedureDefinitionServiceDependencies) {
    this.#clock = clock;
    this.#repository = procedureDefinitionRepository;
    this.#compiler = procedureDefinitionCompiler;
  }

  compile(input: AutonomousProcedureDefinitionCompilationInput): CompiledAutonomousProcedureDefinition {
    return this.#compiler(input);
  }

  publish(
    input: AutonomousProcedureDefinitionCompilationInput,
    publisher: string,
  ): PublishedProcedureDefinition {
    const definition = this.#compiler(input);
    return this.#repository.publish(
      definition,
      input.sourceName ?? "<procedure>",
      publisher,
      this.#clock.now().toISOString(),
    );
  }

  find(procedure: string, version: string): PublishedProcedureDefinition | undefined {
    return this.#repository.find(procedure, version);
  }

  findCapabilityRequirement(
    capability: string,
    actionContractDigest: string,
  ): CompiledRequiredCapability | undefined {
    return this.#repository.findCapabilityRequirement(capability, actionContractDigest);
  }

}
