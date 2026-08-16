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
import { DEFAULT_SESSION_DURATION_MS, PlanRuntime } from "./plan/runtime.js";
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
import { createDiagnosticsHttpHandler } from "./http/diagnostics.js";
import { createOtlpHttpHandler } from "./http/otlp.js";
import { createRpcHttpHandler } from "./http/rpc.js";
import { TrialRegistry } from "./trial/registry.js";
import { DEFAULT_TRIAL_TIMEOUT_MS, defaultRunnerTrialScript, TrialService } from "./trial/service.js";
import { createDatabase, type Database } from "./database/database.js";
import { EnvironmentStore } from "./environment/store.js";
import { EnvironmentService } from "./environment/service.js";
import { CredentialStore } from "./credential/store.js";
import { CredentialService } from "./credential/service.js";

export interface RuntimeComponents {
  readonly databasePath: string;
  readonly semanticAuthority: string;
  readonly databaseDriver: DatabaseDriver;
  readonly database: Database;
  readonly clock: Clock;
  readonly health: Health;
  readonly operations: readonly CompiledOperation[];
  readonly environmentStore: EnvironmentStore;
  readonly environmentService: EnvironmentService;
  readonly credentialStore: CredentialStore;
  readonly credentialService: CredentialService;
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
  readonly sessionDurationMs: number;
  readonly rpcHttpHandler: Router;
  readonly mcpHttpHandler: Router;
  readonly otlpHttpHandler: Router;
  readonly diagnosticsHttpHandler: Router;
  readonly trialRegistry: TrialRegistry;
  readonly trialService: TrialService;
  readonly diagnosticsEndpoint: string;
  readonly runnerTrialScript: string;
  readonly trialTimeoutMs: number;
  readonly httpApp: Express;
}

export interface RuntimeContainerOptions {
  databasePath?: string;
  semanticAuthority?: string;
  registryPrincipalConfigurations?: readonly RegistryPrincipalConfiguration[];
  skillPolicy?: SkillPolicy;
  skillOperabilityPolicy?: SkillOperabilityPolicy;
  sessionDurationMs?: number;
  operations?: readonly CompiledOperation[];
  /** Base URL trial runners post their diagnostics to (this runtime's own diagnostic receiver). */
  diagnosticsEndpoint?: string;
  runnerTrialScript?: string;
  trialTimeoutMs?: number;
}

export const createRuntimeContainer = async (
  options: RuntimeContainerOptions = {},
): Promise<AwilixContainer<RuntimeComponents>> => {
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
    skillPolicy: asValue(skillPolicy),
    skillOperabilityPolicy: asValue(
      options.skillOperabilityPolicy ?? DEFAULT_SKILL_OPERABILITY_POLICY,
    ),
    sessionDurationMs: asValue(options.sessionDurationMs ?? DEFAULT_SESSION_DURATION_MS),
    databaseDriver: asClass(SqliteDatabaseDriver)
      .singleton()
      .disposer((databaseDriver) => databaseDriver.close()),
    database: asFunction(createDatabase)
      .singleton()
      .disposer((database) => database.destroy()),
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
    environmentStore: asClass(EnvironmentStore).singleton(),
    environmentService: asClass(EnvironmentService).singleton(),
    credentialStore: asClass(CredentialStore).singleton(),
    credentialService: asClass(CredentialService).singleton(),
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
    diagnosticsHttpHandler: asFunction(createDiagnosticsHttpHandler).singleton(),
    trialRegistry: asFunction(() => new TrialRegistry()).singleton(),
    trialService: asClass(TrialService).singleton(),
    diagnosticsEndpoint: asValue(options.diagnosticsEndpoint ?? "http://127.0.0.1:4318/otlp/diagnostics"),
    runnerTrialScript: asValue(options.runnerTrialScript ?? defaultRunnerTrialScript()),
    trialTimeoutMs: asValue(options.trialTimeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS),
    httpApp: asFunction(createHttpApp).singleton(),
  });

  try {
    // Fail closed before opening the public listener when authority configuration is malformed.
    container.resolve("registryAuthority");
    initializeCurrentSchema(container.resolve("databaseDriver"));
    await container.resolve("credentialService").initialize();
    await container.resolve("environmentService").initialize();
    return container;
  } catch (error) {
    await container.dispose();
    throw error;
  }
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
