import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
  type AwilixContainer,
} from "awilix";
import type { Express, Router } from "express";
import type { CompiledOperation } from "@trust/operation";
import { PlanReader } from "./plan/read.js";
import { Health } from "./health.js";
import { PlanRuntime } from "./plan/runtime.js";
import { Procedures } from "./procedure/procedures.js";
import { SkillPreflight } from "./skill/preflight.js";
import {
  LocalSkillAdmission,
  VerifiedSkillAdmission,
  type SkillAdmission,
  type SkillPolicy,
  type VerifiedSkillAdmissionDependencies,
} from "./skill/admission.js";
import { SkillRegistry } from "./skill/registry.js";
import { SkillCompatibility } from "./skill/compatibility.js";
import { SnapshotStore } from "./sqlite/snapshots.js";
import { AttemptStore } from "./sqlite/attempts.js";
import { FactStore } from "./sqlite/facts.js";
import { PlanStore } from "./sqlite/plans.js";
import { ProcedureStore } from "./sqlite/procedures.js";
import { SessionStore } from "./sqlite/sessions.js";
import { SkillStore } from "./sqlite/skills.js";
import { initializeCurrentSchema } from "./sqlite/schema.js";
import { SqliteDatabaseDriver } from "./sqlite/database.js";
import { SystemClock, type Clock } from "./time.js";
import { ConfiguredRegistryAuthority } from "./skill/configured-authority.js";
import { LocalRegistryAuthority } from "./skill/local-authority.js";
import type { DatabaseDriver } from "./sqlite/database.js";
import type { RuntimeJsonObject } from "./model.js";
import type {
  RegistryAuthority,
  RegistryPrincipalConfiguration,
} from "./skill/authority.js";
import {
  DEFAULT_SKILL_OPERABILITY_POLICY,
  type SkillOperabilityPolicy,
} from "./skill/model.js";
import { createHttpApp } from "./http/app.js";
import { createMcpHttpHandler } from "./http/mcp.js";
import { createOtlpHttpHandler } from "./http/otlp.js";
import { createRpcHttpHandler } from "./http/rpc.js";

export interface RuntimeComponents {
  readonly databasePath: string;
  readonly semanticAuthority: string;
  readonly databaseDriver: DatabaseDriver;
  readonly clock: Clock;
  readonly health: Health;
  readonly operations: readonly CompiledOperation[];
  readonly environments: Readonly<Record<string, RuntimeJsonObject>>;
  readonly planStore: PlanStore;
  readonly procedureStore: ProcedureStore;
  readonly procedures: Procedures;
  readonly sessionStore: SessionStore;
  readonly attemptStore: AttemptStore;
  readonly factStore: FactStore;
  readonly snapshotStore: SnapshotStore;
  readonly skillStore: SkillStore;
  readonly skillRegistry: SkillRegistry;
  readonly skillCompatibility: SkillCompatibility;
  readonly skillPreflight: SkillPreflight;
  readonly skillAdmission: SkillAdmission;
  readonly planRuntime: PlanRuntime;
  readonly planReader: PlanReader;
  readonly registryPrincipalConfigurations: readonly RegistryPrincipalConfiguration[];
  readonly registryAuthority: RegistryAuthority;
  readonly skillPolicy: SkillPolicy;
  readonly skillOperabilityPolicy: SkillOperabilityPolicy;
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
  operations?: readonly CompiledOperation[];
  environments?: Readonly<Record<string, RuntimeJsonObject>>;
}

export const createRuntimeContainer = (
  options: RuntimeContainerOptions = {},
): AwilixContainer<RuntimeComponents> => {
  const skillPolicy = options.skillPolicy ?? "local";
  const container = createContainer<RuntimeComponents>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  container.register({
    databasePath: asValue(options.databasePath ?? ".trust/trust.sqlite"),
    semanticAuthority: asValue(options.semanticAuthority ?? "localhost:4318"),
    registryPrincipalConfigurations: asValue(options.registryPrincipalConfigurations ?? []),
    operations: asValue(options.operations ?? []),
    environments: asValue(options.environments ?? {}),
    skillPolicy: asValue(skillPolicy),
    skillOperabilityPolicy: asValue(
      options.skillOperabilityPolicy ?? DEFAULT_SKILL_OPERABILITY_POLICY,
    ),
    databaseDriver: asClass(SqliteDatabaseDriver)
      .singleton()
      .disposer((databaseDriver) => databaseDriver.close()),
    clock: asClass(SystemClock).singleton(),
    registryAuthority: asFunction(createRegistryAuthority).singleton(),
    health: asClass(Health).singleton(),
    planStore: asClass(PlanStore).singleton(),
    procedureStore: asClass(ProcedureStore).singleton(),
    procedures: asClass(Procedures).singleton(),
    sessionStore: asClass(SessionStore).singleton(),
    attemptStore: asClass(AttemptStore).singleton(),
    factStore: asClass(FactStore).singleton(),
    snapshotStore: asClass(SnapshotStore).singleton(),
    skillStore: asClass(SkillStore).singleton(),
    skillRegistry: asClass(SkillRegistry).singleton(),
    skillCompatibility: asClass(SkillCompatibility).singleton(),
    skillPreflight: asClass(SkillPreflight).singleton(),
    skillAdmission: asFunction(createSkillAdmission).singleton(),
    planRuntime: asClass(PlanRuntime).singleton(),
    planReader: asClass(PlanReader).singleton(),
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
}: Pick<RuntimeComponents, "skillPolicy" | "registryPrincipalConfigurations">): RegistryAuthority {
  return skillPolicy === "local"
    ? new LocalRegistryAuthority()
    : new ConfiguredRegistryAuthority({ registryPrincipalConfigurations });
}

function createSkillAdmission({
  skillPolicy,
  skillPreflight,
  skillStore,
}: Pick<
  RuntimeComponents,
  "skillPolicy" | "skillPreflight" | "skillStore"
>): SkillAdmission {
  if (skillPolicy === "local") return new LocalSkillAdmission();
  const dependencies: VerifiedSkillAdmissionDependencies = {
    skillPreflight,
    skillStore,
  };
  return new VerifiedSkillAdmission(dependencies);
}
