import { createServer, type Server } from "node:http";
import { createRuntimeContainer } from "./container.js";
import type { SkillOperabilityPolicy } from "./domain/skill-registry.js";
import type { SkillPolicy } from "./application/skill-admission-service.js";
import type { RegistryPrincipalConfiguration } from "./ports/registry-authority.js";
import type { RuntimeJsonObject } from "./domain/runtime-model.js";
import type { ConfiguredExecution } from "./application/execution-definition-service.js";

export interface RuntimeServerOptions {
  readonly host: string;
  readonly port: number;
  readonly databasePath?: string;
  readonly semanticAuthority?: string;
  readonly registryPrincipalConfigurations?: readonly RegistryPrincipalConfiguration[];
  readonly skillPolicy?: SkillPolicy;
  readonly skillOperabilityPolicy?: SkillOperabilityPolicy;
  readonly configuredExecutions?: readonly ConfiguredExecution[];
  readonly executionEnvironments?: Readonly<Record<string, RuntimeJsonObject>>;
}

export interface RunningRuntime {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const listen = (server: Server, host: string, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

export const startRuntime = async ({
  host,
  port,
  databasePath,
  semanticAuthority,
  registryPrincipalConfigurations,
  skillPolicy,
  skillOperabilityPolicy,
  configuredExecutions,
  executionEnvironments,
}: RuntimeServerOptions): Promise<RunningRuntime> => {
  const container = createRuntimeContainer({
    ...(databasePath ? { databasePath } : {}),
    ...(semanticAuthority ? { semanticAuthority } : {}),
    ...(registryPrincipalConfigurations
      ? { registryPrincipalConfigurations }
      : {}),
    ...(skillPolicy ? { skillPolicy } : {}),
    ...(skillOperabilityPolicy ? { skillOperabilityPolicy } : {}),
    ...(configuredExecutions ? { configuredExecutions } : {}),
    ...(executionEnvironments ? { executionEnvironments } : {}),
  });
  const server = createServer(container.resolve("httpApp"));
  await listen(server, host, port);

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("TRUST runtime did not bind a TCP address.");
  }

  return {
    host,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await container.dispose();
    },
  };
};
