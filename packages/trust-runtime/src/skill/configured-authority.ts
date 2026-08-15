import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

import {
  REGISTRY_ROLES,
  RegistryAuthorityError,
  type RegistryAuthorizationRequest,
  type RegistryAuthority,
  type RegistryPrincipal,
  type RegistryPrincipalConfiguration,
  type RegistryRole,
} from "../skill/authority.js";

interface ConfiguredRegistryAuthorityDependencies {
  readonly registryPrincipalConfigurations: readonly RegistryPrincipalConfiguration[];
}

interface ApprovedPrincipal extends RegistryPrincipal {
  readonly credentialDigest: Buffer;
  readonly publicKey?: KeyObject;
}

const SHA256_FINGERPRINT = /^sha256:([0-9a-f]{64})$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;
const registryRoles = new Set<string>(REGISTRY_ROLES);

/**
 * Registry authority for one runtime process.
 *
 * Configuration contains only public identity material and credential fingerprints. Bearer
 * credentials are request-scoped, hashed in memory and never persisted in TRUST's model.
 */
export class ConfiguredRegistryAuthority implements RegistryAuthority {
  readonly #principals: readonly ApprovedPrincipal[];

  constructor({ registryPrincipalConfigurations }: ConfiguredRegistryAuthorityDependencies) {
    this.#principals = validateConfigurations(registryPrincipalConfigurations);
  }

  authorize(request: RegistryAuthorizationRequest): RegistryPrincipal {
    if (request.anyRoleOf.length === 0) {
      throw new Error("Registry authorization requires at least one bounded role");
    }
    const credential = bearerCredential(request.authorizationHeader);
    const credentialDigest = createHash("sha256").update(credential, "utf8").digest();

    let principal: ApprovedPrincipal | undefined;
    for (const candidate of this.#principals) {
      const matches = timingSafeEqual(credentialDigest, candidate.credentialDigest);
      if (matches) principal = candidate;
    }
    if (!principal) {
      throw new RegistryAuthorityError(
        "credential-invalid",
        "the registry bearer credential is not approved",
      );
    }

    if (!request.anyRoleOf.some((role) => principal.roles.includes(role))) {
      throw new RegistryAuthorityError(
        "role-denied",
        "the registry principal does not hold a required role",
      );
    }

    if (
      request.assertedIdentity !== undefined &&
      canonicalIdentity(request.assertedIdentity) !== principal.identity
    ) {
      throw new RegistryAuthorityError(
        "identity-mismatch",
        "the authenticated registry principal does not own the asserted identity",
      );
    }

    if (request.signedRecord !== undefined) {
      if (!principal.publicKey) {
        throw new RegistryAuthorityError(
          "signature-invalid",
          "the registry principal has no approved Ed25519 verification key",
        );
      }
      const signature = decodeSignature(request.signedRecord.signature);
      const payload = Buffer.from(canonicalJson(request.signedRecord.value), "utf8");
      if (!verify(null, payload, principal.publicKey, signature)) {
        throw new RegistryAuthorityError(
          "signature-invalid",
          "the registry record signature is not valid for the approved principal key",
        );
      }
    }

    return { identity: principal.identity, roles: principal.roles };
  }
}

export function parseRegistryPrincipalConfigurations(
  serialized: string | undefined,
): readonly RegistryPrincipalConfiguration[] {
  if (serialized === undefined || serialized.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("TRUST_REGISTRY_PRINCIPALS_JSON must contain valid JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("TRUST_REGISTRY_PRINCIPALS_JSON must be a JSON array");
  }
  return parsed.map((candidate, index) => parseConfiguration(candidate, index));
}

function parseConfiguration(value: unknown, index: number): RegistryPrincipalConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`registry principal[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["identity", "roles", "credentialSha256", "publicKey"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(
      `registry principal[${index}] may contain only identity, roles, credentialSha256 and publicKey`,
    );
  }
  if (
    typeof record.identity !== "string" ||
    !Array.isArray(record.roles) ||
    record.roles.some((role) => typeof role !== "string" || !registryRoles.has(role)) ||
    typeof record.credentialSha256 !== "string" ||
    (record.publicKey !== undefined && typeof record.publicKey !== "string")
  ) {
    throw new Error(`registry principal[${index}] has an invalid configuration shape`);
  }
  return {
    identity: record.identity,
    roles: record.roles as RegistryRole[],
    credentialSha256: record.credentialSha256,
    ...(record.publicKey === undefined ? {} : { publicKey: record.publicKey }),
  };
}

function validateConfigurations(
  configurations: readonly RegistryPrincipalConfiguration[],
): readonly ApprovedPrincipal[] {
  const identities = new Set<string>();
  const credentialDigests = new Set<string>();
  return configurations.map((configuration, index) => {
    const identity = canonicalIdentity(configuration.identity);
    if (identities.has(identity)) {
      throw new Error(`registry principal[${index}] duplicates identity ${identity}`);
    }
    identities.add(identity);

    const fingerprint = SHA256_FINGERPRINT.exec(configuration.credentialSha256);
    if (!fingerprint?.[1]) {
      throw new Error(
        `registry principal[${index}].credentialSha256 must be sha256:<64 lowercase hex>`,
      );
    }
    if (credentialDigests.has(configuration.credentialSha256)) {
      throw new Error(`registry principal[${index}] duplicates a credential fingerprint`);
    }
    credentialDigests.add(configuration.credentialSha256);

    if (
      configuration.roles.length === 0 ||
      new Set(configuration.roles).size !== configuration.roles.length ||
      configuration.roles.some((role) => !registryRoles.has(role))
    ) {
      throw new Error(`registry principal[${index}].roles must be non-empty, unique and bounded`);
    }

    const publicKey = configuration.publicKey === undefined
      ? undefined
      : approvedEd25519PublicKey(configuration.publicKey, index);
    if (
      configuration.roles.includes("distribution-verifier") &&
      publicKey === undefined
    ) {
      throw new Error(`registry verifier principal[${index}] requires an Ed25519 publicKey`);
    }

    return {
      identity,
      roles: Object.freeze([...configuration.roles]),
      credentialDigest: Buffer.from(fingerprint[1], "hex"),
      ...(publicKey === undefined ? {} : { publicKey }),
    };
  });
}

function approvedEd25519PublicKey(value: string, index: number): KeyObject {
  if (
    !value.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    !value.endsWith("-----END PUBLIC KEY-----\n") ||
    value.includes("PRIVATE KEY")
  ) {
    throw new Error(
      `registry principal[${index}].publicKey must be a canonical SPKI public key PEM`,
    );
  }
  let key: KeyObject;
  try {
    key = createPublicKey(value);
  } catch (error) {
    throw new Error(`registry principal[${index}].publicKey is not a valid public key`, {
      cause: error,
    });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`registry principal[${index}].publicKey must be Ed25519`);
  }
  const canonicalSpki = key.export({ type: "spki", format: "pem" }).toString();
  if (canonicalSpki !== value) {
    throw new Error(
      `registry principal[${index}].publicKey must use canonical Ed25519 SPKI PEM encoding`,
    );
  }
  return key;
}

function bearerCredential(header: string | undefined): string {
  if (header === undefined) {
    throw new RegistryAuthorityError(
      "credential-required",
      "a bearer credential is required for registry methods",
    );
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match?.[1]) {
    throw new RegistryAuthorityError(
      "credential-invalid",
      "the registry Authorization header must contain one Bearer credential",
    );
  }
  return match[1];
}

function canonicalIdentity(value: string): string {
  let identity: URL;
  try {
    identity = new URL(value);
  } catch {
    throw new RegistryAuthorityError(
      "identity-mismatch",
      "registry identity must be an absolute URI",
    );
  }
  if (
    identity.username !== "" ||
    identity.password !== "" ||
    identity.search !== "" ||
    identity.hash !== ""
  ) {
    throw new RegistryAuthorityError(
      "identity-mismatch",
      "registry identity URI cannot contain credentials, a query or a fragment",
    );
  }
  return identity.href;
}

function decodeSignature(value: string): Buffer {
  if (!BASE64_SIGNATURE.test(value)) {
    throw new RegistryAuthorityError("signature-invalid", "registry signature must be base64");
  }
  const signature = Buffer.from(value, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== value) {
    throw new RegistryAuthorityError(
      "signature-invalid",
      "registry signature must be one canonical Ed25519 signature",
    );
  }
  return signature;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("signed registry records require finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("signed registry records must contain only JSON values");
}
