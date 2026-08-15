export const REGISTRY_ROLES = [
  "publisher",
  "runtime",
  "runtime-process",
  "distribution-verifier",
  "operator",
  "observer",
] as const;

export type RegistryRole = (typeof REGISTRY_ROLES)[number];

export interface RegistryPrincipalConfiguration {
  readonly identity: string;
  readonly roles: readonly RegistryRole[];
  readonly credentialSha256: string;
  readonly publicKey?: string;
}

export interface RegistryPrincipal {
  readonly identity: string;
  readonly roles: readonly RegistryRole[];
}

export interface RegistrySignedRecord {
  readonly value: unknown;
  readonly signature: string;
}

export interface RegistryAuthorizationRequest {
  readonly authorizationHeader?: string;
  readonly anyRoleOf: readonly RegistryRole[];
  readonly assertedIdentity?: string;
  readonly signedRecord?: RegistrySignedRecord;
}

export interface RegistryAuthority {
  authorize(request: RegistryAuthorizationRequest): RegistryPrincipal;
}

export type RegistryAuthorityErrorReason =
  | "credential-required"
  | "credential-invalid"
  | "role-denied"
  | "identity-mismatch"
  | "signature-invalid";

export class RegistryAuthorityError extends Error {
  constructor(
    readonly reason: RegistryAuthorityErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "RegistryAuthorityError";
  }
}
