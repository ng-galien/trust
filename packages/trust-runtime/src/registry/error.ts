import type { RegistryErrorReason, RegistryFailure, RegistryStep } from "@trust/extension-sdk";

export class RegistryError extends Error {
  constructor(
    readonly reason: RegistryErrorReason,
    message: string,
    readonly artifact?: string,
    readonly summary?: { readonly imported: number; readonly unchanged: number; readonly failed: number },
    readonly step?: RegistryStep,
    readonly output?: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/** The closed public refusal body shared by RPC error data and MCP error results. */
export function registryFailure(error: RegistryError): RegistryFailure {
  return {
    contract: "trust.registry-error@1",
    reason: error.reason,
    message: error.message,
    ...(error.artifact === undefined ? {} : { artifact: error.artifact }),
    ...(error.step === undefined ? {} : { step: error.step }),
    ...(error.output === undefined ? {} : { output: error.output }),
    summary: error.summary ?? { imported: 0, unchanged: 0, failed: 1 },
  };
}
