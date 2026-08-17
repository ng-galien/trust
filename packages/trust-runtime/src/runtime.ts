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
import { SnapshotStore } from "./snapshot/store.js";
import { AttemptStore } from "./attempt/store.js";
import { FactStore } from "./fact/store.js";
import { PlanStore } from "./plan/store.js";
import { ProcedureStore } from "./procedure/store.js";
import { SessionStore } from "./session/store.js";
import { SystemClock, type Clock } from "./time.js";
import { createHttpApp } from "./http/app.js";
import { createMcpHttpHandler } from "./http/mcp.js";
import { createDiagnosticsHttpHandler } from "./http/diagnostics.js";
import { createOtlpHttpHandler } from "./http/otlp.js";
import { createRpcHttpHandler } from "./http/rpc.js";
import { TrialRegistry } from "./trial/registry.js";
import { DEFAULT_TRIAL_TIMEOUT_MS, defaultRunnerTrialScript, TrialService } from "./trial/service.js";
import type { Database } from "./database/database.js";
import { createSqliteDatabase } from "./database/sqlite.js";
import { EnvironmentStore } from "./environment/store.js";
import { EnvironmentService } from "./environment/service.js";
import { CredentialStore } from "./credential/store.js";
import { CredentialService } from "./credential/service.js";
import { PlanEvents } from "./plan/events.js";
import { createPlanEventsHttpHandler } from "./http/events.js";
import { OperationCatalog } from "./operation/catalog.js";

export interface RuntimeComponents {
  readonly databasePath: string;
  readonly semanticAuthority: string;
  readonly database: Database;
  readonly clock: Clock;
  readonly health: Health;
  readonly operations: readonly CompiledOperation[];
  readonly operationsDirectory?: string;
  readonly operationCatalog: OperationCatalog;
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
  readonly planRuntime: PlanRuntime;
  readonly planReader: PlanReader;
  readonly planEvents: PlanEvents;
  readonly sessionDurationMs: number;
  readonly rpcHttpHandler: Router;
  readonly mcpHttpHandler: Router;
  readonly otlpHttpHandler: Router;
  readonly diagnosticsHttpHandler: Router;
  readonly planEventsHttpHandler: Router;
  readonly trialRegistry: TrialRegistry;
  readonly trialService: TrialService;
  readonly diagnosticsEndpoint: string;
  readonly runnerTrialScript: string;
  readonly trialTimeoutMs: number;
  readonly httpApp: Express;
}

export interface RuntimeContainerOptions {
  databasePath?: string;
  database?: Database;
  semanticAuthority?: string;
  sessionDurationMs?: number;
  operations?: readonly CompiledOperation[];
  operationsDirectory?: string;
  /** Base URL trial runners post their diagnostics to (this runtime's own diagnostic receiver). */
  diagnosticsEndpoint?: string;
  runnerTrialScript?: string;
  trialTimeoutMs?: number;
}

export const createRuntimeContainer = async (
  options: RuntimeContainerOptions = {},
): Promise<AwilixContainer<RuntimeComponents>> => {
  const container = createContainer<RuntimeComponents>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  container.register({
    databasePath: asValue(options.databasePath ?? ".trust/trust.sqlite"),
    semanticAuthority: asValue(options.semanticAuthority ?? "localhost:4318"),
    operations: asValue(options.operations ?? []),
    operationsDirectory: asValue(options.operationsDirectory),
    operationCatalog: asClass(OperationCatalog).singleton(),
    sessionDurationMs: asValue(options.sessionDurationMs ?? DEFAULT_SESSION_DURATION_MS),
    database: options.database === undefined
      ? asFunction(createSqliteDatabase)
          .singleton()
          .disposer((database) => database.destroy())
      : asValue(options.database),
    clock: asClass(SystemClock).singleton(),
    health: asClass(Health).singleton(),
    planStore: asClass(PlanStore).singleton(),
    procedureStore: asClass(ProcedureStore).singleton(),
    procedures: asClass(Procedures).singleton(),
    sessionStore: asClass(SessionStore).singleton(),
    attemptStore: asClass(AttemptStore).singleton(),
    factStore: asClass(FactStore).singleton(),
    snapshotStore: asClass(SnapshotStore).singleton(),
    planEvents: asClass(PlanEvents).singleton(),
    environmentStore: asClass(EnvironmentStore).singleton(),
    environmentService: asClass(EnvironmentService).singleton(),
    credentialStore: asClass(CredentialStore).singleton(),
    credentialService: asClass(CredentialService).singleton(),
    planRuntime: asClass(PlanRuntime).singleton(),
    planReader: asClass(PlanReader).singleton(),
    rpcHttpHandler: asFunction(createRpcHttpHandler).singleton(),
    mcpHttpHandler: asFunction(createMcpHttpHandler).singleton(),
    otlpHttpHandler: asFunction(createOtlpHttpHandler).singleton(),
    diagnosticsHttpHandler: asFunction(createDiagnosticsHttpHandler).singleton(),
    planEventsHttpHandler: asFunction(createPlanEventsHttpHandler).singleton(),
    trialRegistry: asFunction(() => new TrialRegistry()).singleton(),
    trialService: asClass(TrialService).singleton(),
    diagnosticsEndpoint: asValue(options.diagnosticsEndpoint ?? "http://127.0.0.1:4318/otlp/diagnostics"),
    runnerTrialScript: asValue(options.runnerTrialScript ?? defaultRunnerTrialScript()),
    trialTimeoutMs: asValue(options.trialTimeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS),
    httpApp: asFunction(createHttpApp).singleton(),
  });

  try {
    await container.resolve("operationCatalog").initialize();
    await container.resolve("credentialService").initialize();
    await container.resolve("environmentService").initialize();
    return container;
  } catch (error) {
    await container.dispose();
    throw error;
  }
};
