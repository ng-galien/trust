import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
  type AwilixContainer,
} from "awilix";
import type { Express, Router } from "express";
import { compileAutonomousProcedureDefinition } from "@trust/procedure";
import { AgentReadService } from "./application/agent-read-service.js";
import { HealthService } from "./application/health-service.js";
import {
  ExecutionDefinitionService,
  type ConfiguredExecution,
} from "./application/execution-definition-service.js";
import { PlanRuntimeService } from "./application/plan-runtime-service.js";
import { ProcedureDefinitionService } from "./application/procedure-definition-service.js";
import { SkillPreflightService } from "./application/skill-preflight-service.js";
import {
  LocalSkillAdmissionService,
  VerifiedSkillAdmissionService,
  type SkillAdmissionService,
  type SkillPolicy,
  type VerifiedSkillAdmissionServiceDependencies,
} from "./application/skill-admission-service.js";
import { SkillRegistryService } from "./application/skill-registry-service.js";
import { SkillReleaseCompatibilityService } from "./application/skill-release-compatibility-service.js";
import { CheckSnapshotRepository } from "./infrastructure/repositories/check-snapshot-repository.js";
import { ExecutionRepository } from "./infrastructure/repositories/execution-repository.js";
import { FactRepository } from "./infrastructure/repositories/fact-repository.js";
import { PlanRepository } from "./infrastructure/repositories/plan-repository.js";
import { ProcedureDefinitionRepository } from "./infrastructure/repositories/procedure-definition-repository.js";
import { SessionRepository } from "./infrastructure/repositories/session-repository.js";
import { SkillRegistryRepository } from "./infrastructure/repositories/skill-registry-repository.js";
import { initializeCurrentSchema } from "./infrastructure/current-schema.js";
import { SqliteDatabaseDriver } from "./infrastructure/sqlite-database-driver.js";
import { SystemClock } from "./infrastructure/system-clock.js";
import { ConfiguredRegistryAuthority } from "./infrastructure/configured-registry-authority.js";
import { LocalRegistryAuthority } from "./infrastructure/local-registry-authority.js";
import type { Clock } from "./ports/clock.js";
import type { DatabaseDriver } from "./ports/database.js";
import type { RuntimeJsonObject } from "./domain/runtime-model.js";
import type {
  RegistryAuthority,
  RegistryPrincipalConfiguration,
} from "./ports/registry-authority.js";
import {
  DEFAULT_SKILL_OPERABILITY_POLICY,
  type SkillOperabilityPolicy,
} from "./domain/skill-registry.js";
import { createHttpApp } from "./presentation/http-app.js";
import { createMcpHttpHandler } from "./presentation/mcp-http.js";
import { createOtlpHttpHandler } from "./presentation/otlp-http.js";
import { createRpcHttpHandler } from "./presentation/rpc-http.js";

export interface RuntimeCradle {
  readonly databasePath: string;
  readonly semanticAuthority: string;
  readonly databaseDriver: DatabaseDriver;
  readonly clock: Clock;
  readonly healthService: HealthService;
  readonly configuredExecutions: readonly ConfiguredExecution[];
  readonly executionEnvironments: Readonly<Record<string, RuntimeJsonObject>>;
  readonly executionDefinitionService: ExecutionDefinitionService;
  readonly planRepository: PlanRepository;
  readonly procedureDefinitionRepository: ProcedureDefinitionRepository;
  readonly procedureDefinitionService: ProcedureDefinitionService;
  readonly sessionRepository: SessionRepository;
  readonly executionRepository: ExecutionRepository;
  readonly factRepository: FactRepository;
  readonly checkSnapshotRepository: CheckSnapshotRepository;
  readonly skillRegistryRepository: SkillRegistryRepository;
  readonly skillRegistryService: SkillRegistryService;
  readonly skillReleaseCompatibilityService: SkillReleaseCompatibilityService;
  readonly skillPreflightService: SkillPreflightService;
  readonly skillAdmissionService: SkillAdmissionService;
  readonly planRuntimeService: PlanRuntimeService;
  readonly agentReadService: AgentReadService;
  readonly registryPrincipalConfigurations: readonly RegistryPrincipalConfiguration[];
  readonly registryAuthority: RegistryAuthority;
  readonly skillPolicy: SkillPolicy;
  readonly skillOperabilityPolicy: SkillOperabilityPolicy;
  readonly procedureDefinitionCompiler: typeof compileAutonomousProcedureDefinition;
  readonly rpcHttpHandler: Router;
  readonly mcpHttpHandler: Router;
  readonly otlpHttpHandler: Router;
  readonly httpApp: Express;
}

export interface RuntimeContainerOptions {
  databasePath?: string;
  semanticAuthority?: string;
  registryPrincipalConfigurations?: readonly RegistryPrincipalConfiguration[];
  skillPolicy?: SkillPolicy;
  skillOperabilityPolicy?: SkillOperabilityPolicy;
  configuredExecutions?: readonly ConfiguredExecution[];
  executionEnvironments?: Readonly<Record<string, RuntimeJsonObject>>;
}

export const createRuntimeContainer = (
  options: RuntimeContainerOptions = {},
): AwilixContainer<RuntimeCradle> => {
  const skillPolicy = options.skillPolicy ?? "local";
  const container = createContainer<RuntimeCradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  container.register({
    databasePath: asValue(options.databasePath ?? ".trust/trust.sqlite"),
    semanticAuthority: asValue(options.semanticAuthority ?? "localhost:4318"),
    registryPrincipalConfigurations: asValue(options.registryPrincipalConfigurations ?? []),
    configuredExecutions: asValue(options.configuredExecutions ?? []),
    executionEnvironments: asValue(options.executionEnvironments ?? {}),
    skillPolicy: asValue(skillPolicy),
    skillOperabilityPolicy: asValue(
      options.skillOperabilityPolicy ?? DEFAULT_SKILL_OPERABILITY_POLICY,
    ),
    databaseDriver: asClass(SqliteDatabaseDriver)
      .singleton()
      .disposer((databaseDriver) => databaseDriver.close()),
    clock: asClass(SystemClock).singleton(),
    registryAuthority: asFunction(createRegistryAuthority).singleton(),
    healthService: asClass(HealthService).singleton(),
    executionDefinitionService: asClass(ExecutionDefinitionService).singleton(),
    planRepository: asClass(PlanRepository).singleton(),
    procedureDefinitionRepository: asClass(ProcedureDefinitionRepository).singleton(),
    procedureDefinitionService: asClass(ProcedureDefinitionService).singleton(),
    sessionRepository: asClass(SessionRepository).singleton(),
    executionRepository: asClass(ExecutionRepository).singleton(),
    factRepository: asClass(FactRepository).singleton(),
    checkSnapshotRepository: asClass(CheckSnapshotRepository).singleton(),
    skillRegistryRepository: asClass(SkillRegistryRepository).singleton(),
    skillRegistryService: asClass(SkillRegistryService).singleton(),
    skillReleaseCompatibilityService: asClass(SkillReleaseCompatibilityService).singleton(),
    skillPreflightService: asClass(SkillPreflightService).singleton(),
    skillAdmissionService: asFunction(createSkillAdmissionService).singleton(),
    procedureDefinitionCompiler: asValue(compileAutonomousProcedureDefinition),
    planRuntimeService: asClass(PlanRuntimeService).singleton(),
    agentReadService: asClass(AgentReadService).singleton(),
    rpcHttpHandler: asFunction(createRpcHttpHandler).singleton(),
    mcpHttpHandler: asFunction(createMcpHttpHandler).singleton(),
    otlpHttpHandler: asFunction(createOtlpHttpHandler).singleton(),
    httpApp: asFunction(createHttpApp).singleton(),
  });

  // Fail closed before opening the public listener when authority configuration is malformed.
  container.resolve("registryAuthority");
  initializeCurrentSchema(container.resolve("databaseDriver"));
  return container;
};

function createRegistryAuthority({
  skillPolicy,
  registryPrincipalConfigurations,
}: Pick<RuntimeCradle, "skillPolicy" | "registryPrincipalConfigurations">): RegistryAuthority {
  return skillPolicy === "local"
    ? new LocalRegistryAuthority()
    : new ConfiguredRegistryAuthority({ registryPrincipalConfigurations });
}

function createSkillAdmissionService({
  skillPolicy,
  skillPreflightService,
  skillRegistryRepository,
}: Pick<
  RuntimeCradle,
  "skillPolicy" | "skillPreflightService" | "skillRegistryRepository"
>): SkillAdmissionService {
  if (skillPolicy === "local") return new LocalSkillAdmissionService();
  const dependencies: VerifiedSkillAdmissionServiceDependencies = {
    skillPreflightService,
    skillRegistryRepository,
  };
  return new VerifiedSkillAdmissionService(dependencies);
}
