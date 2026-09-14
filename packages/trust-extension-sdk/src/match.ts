import type { MissionDefinition } from "./index.js";

export type MissionDefinitionHandlers<R> = {
  [K in MissionDefinition["kind"]]: (definition: Extract<MissionDefinition, { kind: K }>) => R;
};

/** Total dispatch over the canonical published/inline mission definition. */
export function matchMissionDefinition<R>(definition: MissionDefinition, handlers: MissionDefinitionHandlers<R>): R {
  // TypeScript cannot retain the discriminant/handler correlation through indexing.
  return handlers[definition.kind](definition as never);
}
