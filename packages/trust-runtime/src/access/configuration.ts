import type { CredentialReference } from "@trust/extension-sdk";

export type AccessFetch = typeof globalThis.fetch;
export type AccessSecretResolver = (reference: CredentialReference) => string | undefined;
