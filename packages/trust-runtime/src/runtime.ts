import type { BrowserAuthenticationConfiguration, StorageConfiguration } from "@trust/extension-sdk";
import { type AccessConfiguration, parseAccessConfiguration } from "@trust/extension-sdk";
import type { CompiledOperation } from "@trust/operation";
import { type AwilixContainer, asClass, asFunction, asValue, createContainer, InjectionMode } from "awilix";
import type { Express, Router } from "express";
import { type AccessFetch, type AccessSecretResolver } from "./access/configuration.js";
import { AccessService } from "./access/service.js";
import { AttemptStore } from "./attempt/store.js";
import { CatalogMetadataStore } from "./catalog/metadata.js";
import { CredentialService } from "./credential/service.js";
import { CredentialStore } from "./credential/store.js";
import type { Database } from "./database/database.js";
import { createDatabase } from "./database/storage.js";
import { EnvironmentService } from "./environment/service.js";
import { EnvironmentStore } from "./environment/store.js";
import { ExtensionHost } from "./extensions/host.js";
import { FactStore } from "./fact/store.js";
import { Health } from "./health.js";
import { createHttpApp } from "./http/app.js";
import { createDiagnosticsHttpHandler } from "./http/diagnostics.js";
import { createPlanEventsHttpHandler } from "./http/events.js";
import { createExtensionsHttpHandler } from "./http/extensions.js";
import { createMcpHttpHandler } from "./http/mcp.js";
import { createOtlpHttpHandler } from "./http/otlp.js";
import { createRpcHttpHandler } from "./http/rpc.js";
import { OperationCatalog } from "./operation/catalog.js";
import { EscalationStore } from "./plan/escalation-store.js";
import { PlanEvents } from "./plan/events.js";
import { PlanReader } from "./plan/read.js";
import { DEFAULT_SESSION_DURATION_MS, PlanRuntime } from "./plan/runtime.js";
import { PlanStore } from "./plan/store.js";
import { Procedures } from "./procedure/procedures.js";
import { ProcedureStore } from "./procedure/store.js";
import { RegistryService } from "./registry/service.js";
import { RegistrySourceStore } from "./registry/store.js";
import { SessionStore } from "./session/store.js";
import { SnapshotStore } from "./snapshot/store.js";
import { TemplateService } from "./template/service.js";
import { type Clock, SystemClock } from "./time.js";
import { TrialRegistry } from "./trial/registry.js";
import { DEFAULT_TRIAL_TIMEOUT_MS, defaultRunnerTrialScript, TrialService } from "./trial/service.js";

export interface RuntimeComponents {
  readonly accessConfiguration: AccessConfiguration;
  readonly accessFetch: AccessFetch;
  readonly accessSecretResolver: AccessSecretResolver;
  readonly accessService: AccessService;
  readonly browserAuthentication: BrowserAuthenticationConfiguration | undefined;
  readonly accessResourceUrl: string | undefined;
  readonly extensionHost: ExtensionHost;
  readonly extensionsHttpHandler: Router;
  readonly extensionsFile: string | undefined;
  readonly extensionTimeoutMs: number;
  readonly storage: StorageConfiguration;
  readonly semanticAuthority: string;
  readonly database: Database;
  readonly clock: Clock;
  readonly health: Health;
  readonly operations: readonly CompiledOperation[];
  readonly operationsDirectory?: string;
  readonly operationCatalog: OperationCatalog;
  readonly catalogMetadata: CatalogMetadataStore;
  readonly registrySourceStore: RegistrySourceStore;
  readonly registryService: RegistryService;
  readonly environmentStore: EnvironmentStore;
  readonly environmentService: EnvironmentService;
  readonly credentialStore: CredentialStore;
  readonly credentialService: CredentialService;
  readonly planStore: PlanStore;
  readonly procedureStore: ProcedureStore;
  readonly procedures: Procedures;
  readonly templateService: TemplateService;
  readonly sessionStore: SessionStore;
  readonly attemptStore: AttemptStore;
  readonly factStore: FactStore;
  readonly snapshotStore: SnapshotStore;
  readonly escalationStore: EscalationStore;
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
  accessConfiguration?: AccessConfiguration;
  accessFetch?: AccessFetch;
  accessSecretResolver?: AccessSecretResolver;
  clock?: Clock;
  browserAuthentication?: BrowserAuthenticationConfiguration;
  accessResourceUrl?: string;
  extensionsFile?: string;
  extensionTimeoutMs?: number;
  storage?: StorageConfiguration;
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
  const storage = options.storage ?? { kind: "pglite", directory: ".trust/pglite" };
  const accessConfiguration = parseAccessConfiguration(options.accessConfiguration ?? { mode: "local" });
  const database = options.database ?? (await createDatabase({ storage }));

  container.register({
    accessConfiguration: asValue(accessConfiguration),
    browserAuthentication: asValue(options.browserAuthentication),
    accessResourceUrl: asValue(options.accessResourceUrl),
    accessFetch: asValue(options.accessFetch ?? globalThis.fetch),
    accessSecretResolver: options.accessSecretResolver
      ? asValue(options.accessSecretResolver)
      : asFunction(
          ({ credentialService }: { credentialService: CredentialService }): AccessSecretResolver =>
            (reference) =>
              credentialService.resolve(reference.environment)[reference.name],
        ).singleton(),
    accessService: asClass(AccessService).singleton(),
    extensionsFile: asValue(options.extensionsFile),
    extensionTimeoutMs: asValue(options.extensionTimeoutMs ?? 10_000),
    extensionHost: asClass(ExtensionHost)
      .singleton()
      .disposer((host) => host.close()),
    extensionsHttpHandler: asFunction(createExtensionsHttpHandler).singleton(),
    storage: asValue(storage),
    semanticAuthority: asValue(options.semanticAuthority ?? "localhost:4318"),
    operations: asValue(options.operations ?? []),
    operationsDirectory: asValue(options.operationsDirectory),
    operationCatalog: asClass(OperationCatalog).singleton(),
    catalogMetadata: asClass(CatalogMetadataStore).singleton(),
    registrySourceStore: asClass(RegistrySourceStore).singleton(),
    registryService: asClass(RegistryService).singleton(),
    sessionDurationMs: asValue(options.sessionDurationMs ?? DEFAULT_SESSION_DURATION_MS),
    database:
      options.database === undefined
        ? asFunction(() => database)
            .singleton()
            .disposer((database) => database.destroy())
        : asValue(options.database),
    clock: options.clock ? asValue(options.clock) : asClass(SystemClock).singleton(),
    health: asClass(Health).singleton(),
    planStore: asClass(PlanStore).singleton(),
    procedureStore: asClass(ProcedureStore).singleton(),
    procedures: asClass(Procedures).singleton(),
    templateService: asClass(TemplateService).singleton(),
    sessionStore: asClass(SessionStore).singleton(),
    attemptStore: asClass(AttemptStore).singleton(),
    factStore: asClass(FactStore).singleton(),
    snapshotStore: asClass(SnapshotStore).singleton(),
    escalationStore: asClass(EscalationStore).singleton(),
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
    // Resolve the owned singleton before other startup hooks so disposal also covers their failures.
    container.resolve("database");
    await container.resolve("operationCatalog").initialize();
    await container.resolve("credentialService").initialize();
    await container.resolve("environmentService").initialize();
    await container.resolve("extensionHost").initialize();
    return container;
  } catch (error) {
    await container.dispose();
    throw error;
  }
};
