import type { CredentialReference } from "./index.js";

export interface SharedAccessConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly discovery?: "oidc" | "oauth";
  readonly clockToleranceSeconds?: number;
  readonly maxTokenAgeSeconds?: number;
  readonly timeoutMs?: number;
  /** Only for explicitly selected isolated development/test deployments. */
  readonly allowInsecureLoopback?: boolean;
}

export type AccessConfiguration =
  | { readonly mode: "local" }
  | (SharedAccessConfiguration & {
      readonly mode: "local-jwt";
      readonly algorithms?: readonly string[];
      readonly tokenProfile?: {
        readonly headerType: string;
        readonly requiredClaims?: Readonly<Record<string, string>>;
      };
    })
  | (SharedAccessConfiguration & {
      readonly mode: "introspection";
      /** Resolved privately by the server composition root, never returned to clients. */
      readonly introspection: {
        readonly clientId: string;
        readonly clientSecretReference: CredentialReference;
        readonly authenticationMethod?: "client_secret_basic" | "client_secret_post";
      };
    });

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid access configuration object");
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unknown access configuration field");
};
const string = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const asymmetricAlgorithms = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);

export function authorityUrl(value: string, allowInsecureLoopback = false, allowQuery = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid access authority URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (!allowQuery && url.search) ||
    (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:"))
  ) {
    throw new Error("Access authority URL violates the configured transport policy");
  }
  return url;
}

/** Strict boundary for server-resolved configuration; errors never interpolate secrets. */
export function parseAccessConfiguration(value: unknown): AccessConfiguration {
  const input = object(value);
  if (input.mode === "local") {
    keys(input, ["mode"]);
    return Object.freeze({ mode: "local" });
  }
  if (input.mode !== "local-jwt" && input.mode !== "introspection") throw new Error("Unknown access mode");
  keys(input, [
    "mode",
    "issuer",
    "audience",
    "discovery",
    "clockToleranceSeconds",
    "maxTokenAgeSeconds",
    "timeoutMs",
    "allowInsecureLoopback",
    ...(input.mode === "local-jwt" ? ["algorithms", "tokenProfile"] : ["introspection"]),
  ]);
  if (!string(input.issuer) || !string(input.audience)) throw new Error("Access issuer and audience are required");
  if (input.discovery !== undefined && input.discovery !== "oidc" && input.discovery !== "oauth")
    throw new Error("Unknown access discovery protocol");
  if (input.allowInsecureLoopback !== undefined && typeof input.allowInsecureLoopback !== "boolean")
    throw new Error("Invalid access loopback policy");
  authorityUrl(input.issuer, input.allowInsecureLoopback === true);
  for (const [field, maximum, allowZero] of [
    ["clockToleranceSeconds", 60, true],
    ["maxTokenAgeSeconds", 86400, false],
  ] as const) {
    const item = input[field];
    if (
      item !== undefined &&
      (typeof item !== "number" || !Number.isSafeInteger(item) || item < (allowZero ? 0 : 1) || item > maximum)
    ) {
      throw new Error("Invalid access token lifetime policy");
    }
  }
  if (
    input.timeoutMs !== undefined &&
    (typeof input.timeoutMs !== "number" ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 100 ||
      input.timeoutMs > 30_000)
  )
    throw new Error("Invalid access authority timeout");
  const common = {
    issuer: input.issuer,
    audience: input.audience,
    discovery: input.discovery ?? "oidc",
    clockToleranceSeconds: input.clockToleranceSeconds ?? 0,
    maxTokenAgeSeconds: input.maxTokenAgeSeconds ?? 300,
    timeoutMs: input.timeoutMs ?? 5_000,
    allowInsecureLoopback: input.allowInsecureLoopback ?? false,
  } as SharedAccessConfiguration;
  if (input.mode === "introspection") {
    const credentials = object(input.introspection);
    keys(credentials, ["clientId", "clientSecretReference", "authenticationMethod"]);
    const reference = object(credentials.clientSecretReference);
    keys(reference, ["environment", "name"]);
    if (!string(credentials.clientId) || !string(reference.environment) || !string(reference.name))
      throw new Error("Introspection client credential reference is required");
    if (
      credentials.authenticationMethod !== undefined &&
      !["client_secret_basic", "client_secret_post"].includes(String(credentials.authenticationMethod))
    )
      throw new Error("Unsupported introspection client authentication");
    return Object.freeze({
      ...common,
      mode: "introspection",
      introspection: Object.freeze({
        clientId: credentials.clientId,
        clientSecretReference: Object.freeze({ environment: reference.environment, name: reference.name }),
        authenticationMethod: credentials.authenticationMethod ?? "client_secret_basic",
      }),
    }) as AccessConfiguration;
  }
  const algorithms = input.algorithms ?? ["RS256"];
  if (
    !Array.isArray(algorithms) ||
    algorithms.length === 0 ||
    algorithms.some((item) => typeof item !== "string" || !asymmetricAlgorithms.has(item))
  )
    throw new Error("Invalid access signature algorithms");
  const profile = input.tokenProfile === undefined ? { headerType: "at+jwt" } : object(input.tokenProfile);
  keys(profile, ["headerType", "requiredClaims"]);
  if (!string(profile.headerType)) throw new Error("Access token header type is required");
  const requiredClaims = profile.requiredClaims === undefined ? {} : object(profile.requiredClaims);
  if (Object.values(requiredClaims).some((item) => !string(item)))
    throw new Error("Invalid access token profile claims");
  if (!["at+jwt", "application/at+jwt"].includes(profile.headerType) && Object.keys(requiredClaims).length === 0) {
    throw new Error("A non-access-specific JWT type requires an explicit access-token claim discriminator");
  }
  return Object.freeze({
    ...common,
    mode: "local-jwt",
    algorithms: Object.freeze([...algorithms]),
    tokenProfile: Object.freeze({
      headerType: profile.headerType,
      requiredClaims: Object.freeze({ ...requiredClaims }),
    }),
  }) as AccessConfiguration;
}
