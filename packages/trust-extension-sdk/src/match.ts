import type { AccessContext } from "./access.js";
import type { MissionDefinition } from "./index.js";

export type AccessContextHandlers<R> = {
  [K in AccessContext["mode"]]: (context: Extract<AccessContext, { mode: K }>) => R;
};

/** Total dispatch over the canonical local/authenticated request context. */
export function matchAccessContext<R>(context: AccessContext, handlers: AccessContextHandlers<R>): R {
  return handlers[context.mode](context as never);
}

export type MissionDefinitionHandlers<R> = {
  [K in MissionDefinition["kind"]]: (definition: Extract<MissionDefinition, { kind: K }>) => R;
};

/** Total dispatch over the canonical published/inline mission definition. */
export function matchMissionDefinition<R>(definition: MissionDefinition, handlers: MissionDefinitionHandlers<R>): R {
  // TypeScript cannot retain the discriminant/handler correlation through indexing.
  return handlers[definition.kind](definition as never);
}

export type ExtensionInvocationContextHandlers<R> = {
  [K in import("./extension.js").ExtensionInvocationContext["mode"]]: (
    context: Extract<import("./extension.js").ExtensionInvocationContext, { mode: K }>,
  ) => R;
};

export function matchExtensionInvocationContext<R>(
  context: import("./extension.js").ExtensionInvocationContext,
  handlers: ExtensionInvocationContextHandlers<R>,
): R {
  return handlers[context.mode](context as never);
}

export type StorageConfigurationHandlers<R> = {
  [K in import("./configuration.js").StorageConfiguration["kind"]]: (
    value: Extract<import("./configuration.js").StorageConfiguration, { kind: K }>,
  ) => R;
};
export function matchStorageConfiguration<R>(
  value: import("./configuration.js").StorageConfiguration,
  handlers: StorageConfigurationHandlers<R>,
): R {
  return handlers[value.kind](value as never);
}
export type AccessConfigurationHandlers<R> = {
  [K in import("./access-configuration.js").AccessConfiguration["mode"]]: (
    value: Extract<import("./access-configuration.js").AccessConfiguration, { mode: K }>,
  ) => R;
};
export function matchAccessConfiguration<R>(
  value: import("./access-configuration.js").AccessConfiguration,
  handlers: AccessConfigurationHandlers<R>,
): R {
  return handlers[value.mode](value as never);
}
