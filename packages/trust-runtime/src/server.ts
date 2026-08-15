import { createServer, type Server } from "node:http";
import { createRuntimeContainer } from "./runtime.js";
import type { SkillOperabilityPolicy } from "./skill/model.js";
import type { SkillPolicy } from "./skill/admission.js";
import type { RegistryPrincipalConfiguration } from "./skill/authority.js";
import type { RuntimeJsonObject } from "./model.js";
import type { CompiledOperation } from "@trust/operation";

export interface RuntimeServerOptions {
  readonly host: string;
  readonly port: number;
  readonly databasePath?: string;
  readonly semanticAuthority?: string;
  readonly registryPrincipalConfigurations?: readonly RegistryPrincipalConfiguration[];
  readonly skillPolicy?: SkillPolicy;
  readonly skillOperabilityPolicy?: SkillOperabilityPolicy;
  readonly operations?: readonly CompiledOperation[];
  readonly environments?: Readonly<Record<string, RuntimeJsonObject>>;
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
  operations,
  environments,
}: RuntimeServerOptions): Promise<RunningRuntime> => {
  const container = createRuntimeContainer({
    ...(databasePath ? { databasePath } : {}),
    ...(semanticAuthority ? { semanticAuthority } : {}),
    ...(registryPrincipalConfigurations
      ? { registryPrincipalConfigurations }
      : {}),
    ...(skillPolicy ? { skillPolicy } : {}),
    ...(skillOperabilityPolicy ? { skillOperabilityPolicy } : {}),
    ...(operations ? { operations } : {}),
    ...(environments ? { environments } : {}),
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
