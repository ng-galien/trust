import { type AccessConfiguration, authorityUrl } from "@trust/extension-sdk";
import { matchAccessConfiguration } from "@trust/extension-sdk/match";
import { createLocalJWKSet, type JSONWebKeySet, type JWTPayload, jwtVerify } from "jose";
import type { Clock } from "../time.js";
import { type AccessFetch, type AccessSecretResolver } from "./configuration.js";
import { AccessError } from "./error.js";

type SharedConfiguration = Exclude<AccessConfiguration, { mode: "local" | "fixed" }>;
type Metadata = {
  issuer: string;
  jwks_uri?: string;
  introspection_endpoint?: string;
  introspection_endpoint_auth_methods_supported?: string[];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccessError("authority-unavailable", "Invalid authority response");
  return value as Record<string, unknown>;
}

export class AccessProvider {
  #metadata: { value: Metadata; expires: number } | undefined;
  #loadingMetadata: Promise<Metadata> | undefined;
  #keys: ReturnType<typeof createLocalJWKSet> | undefined;
  #keysExpires = 0;
  #lastKeyRequest = -Infinity;
  #loadingKeys: Promise<void> | undefined;

  constructor(
    private readonly configuration: SharedConfiguration,
    private readonly clock: Clock,
    private readonly request: AccessFetch,
    private readonly secret: AccessSecretResolver,
  ) {}

  async #json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    authorityUrl(url, this.configuration.allowInsecureLoopback, true);
    try {
      const response = await this.request(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.configuration.timeoutMs ?? 5_000),
      });
      if (!response.ok) throw new Error("Authority response refused");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing authority response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 1_048_576) {
          await reader.cancel();
          throw new Error("Authority response too large");
        }
        chunks.push(value);
      }
      return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new AccessError("authority-unavailable", "Access authority is unavailable or returned an invalid response");
    }
  }

  async metadata(): Promise<Metadata> {
    const now = this.clock.now().getTime();
    if (this.#metadata && this.#metadata.expires > now) return this.#metadata.value;
    if (this.#loadingMetadata) return this.#loadingMetadata;
    this.#loadingMetadata = this.#loadMetadata();
    try {
      return await this.#loadingMetadata;
    } finally {
      this.#loadingMetadata = undefined;
    }
  }

  async #loadMetadata(): Promise<Metadata> {
    const { issuer, discovery } = this.configuration;
    const issuerUrl = authorityUrl(issuer, this.configuration.allowInsecureLoopback);
    const endpoint =
      discovery === "oauth"
        ? `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname === "/" ? "" : issuerUrl.pathname}`
        : `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await this.#json(endpoint);
    if (response.issuer !== issuer)
      throw new AccessError("authority-unavailable", "Discovered issuer does not match configured issuer");
    for (const field of ["jwks_uri", "introspection_endpoint"] as const) {
      if (response[field] !== undefined) {
        if (typeof response[field] !== "string")
          throw new AccessError("authority-unavailable", "Invalid authority endpoint");
        try {
          authorityUrl(response[field], this.configuration.allowInsecureLoopback, true);
        } catch {
          throw new AccessError("authority-unavailable", "Invalid authority endpoint");
        }
      }
    }
    if (
      response.introspection_endpoint_auth_methods_supported !== undefined &&
      (!Array.isArray(response.introspection_endpoint_auth_methods_supported) ||
        response.introspection_endpoint_auth_methods_supported.some((item) => typeof item !== "string"))
    ) {
      throw new AccessError("authority-unavailable", "Invalid introspection metadata");
    }
    const metadata = response as Metadata;
    this.#metadata = { value: metadata, expires: this.clock.now().getTime() + 300_000 };
    return metadata;
  }

  async #loadKeys(): Promise<void> {
    if (this.#loadingKeys) return this.#loadingKeys;
    this.#loadingKeys = (async () => {
      this.#lastKeyRequest = this.clock.now().getTime();
      const metadata = await this.metadata();
      if (!metadata.jwks_uri) throw new AccessError("authority-unavailable", "Authority does not publish a key set");
      const result = await this.#json(metadata.jwks_uri);
      if (!Array.isArray(result.keys) || result.keys.length > 100)
        throw new AccessError("authority-unavailable", "Invalid authority key set");
      this.#keys = createLocalJWKSet(result as unknown as JSONWebKeySet);
      this.#keysExpires = this.clock.now().getTime() + 300_000;
    })();
    try {
      await this.#loadingKeys;
    } finally {
      this.#loadingKeys = undefined;
    }
  }

  async verifyJwt(token: string): Promise<JWTPayload> {
    const configuration = matchAccessConfiguration(this.configuration, {
      fixed: () => {
        throw new AccessError("unauthenticated", "Fixed access does not use a provider");
      },
      local: () => {
        throw new AccessError("unauthenticated", "JWT validation is not selected");
      },
      "local-jwt": (value) => value,
      introspection: () => {
        throw new AccessError("unauthenticated", "JWT validation is not selected");
      },
    });
    if (!this.#keys || this.#keysExpires <= this.clock.now().getTime()) await this.#loadKeys();
    const verify = async (): Promise<JWTPayload> => {
      if (!this.#keys) throw new AccessError("authority-unavailable", "Authority keys unavailable");
      const type = configuration.tokenProfile?.headerType ?? "at+jwt";
      const profileClaims = ["at+jwt", "application/at+jwt"].includes(type) ? ["client_id", "jti"] : [];
      const { payload } = await jwtVerify(token, this.#keys, {
        algorithms: [...(configuration.algorithms ?? ["RS256"])],
        issuer: configuration.issuer,
        audience: configuration.audience,
        typ: type,
        currentDate: this.clock.now(),
        clockTolerance: configuration.clockToleranceSeconds ?? 0,
        maxTokenAge: configuration.maxTokenAgeSeconds ?? 300,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "scope", ...profileClaims],
      });
      for (const [claim, expected] of Object.entries(configuration.tokenProfile?.requiredClaims ?? {})) {
        if (payload[claim] !== expected) throw new AccessError("unauthenticated", "Access token profile mismatch");
      }
      return payload;
    };
    try {
      return await verify();
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ERR_JWKS_NO_MATCHING_KEY" &&
        this.clock.now().getTime() - this.#lastKeyRequest >= 30_000
      ) {
        await this.#loadKeys();
        try {
          return await verify();
        } catch {
          /* No fallback to stale or unverified tokens. */
        }
      }
      throw new AccessError("unauthenticated", "Access token validation failed");
    }
  }

  async introspect(token: string): Promise<Record<string, unknown>> {
    const configuration = matchAccessConfiguration(this.configuration, {
      fixed: () => {
        throw new AccessError("unauthenticated", "Fixed access does not use a provider");
      },
      local: () => {
        throw new AccessError("unauthenticated", "Introspection is not selected");
      },
      "local-jwt": () => {
        throw new AccessError("unauthenticated", "Introspection is not selected");
      },
      introspection: (value) => value,
    });
    const metadata = await this.metadata();
    if (!metadata.introspection_endpoint)
      throw new AccessError("authority-unavailable", "Authority does not publish introspection");
    const credentials = configuration.introspection;
    let secret: string | undefined;
    try {
      secret = this.secret(credentials.clientSecretReference);
    } catch {
      throw new AccessError("authority-unavailable", "Introspection credential is unavailable");
    }
    if (!secret) throw new AccessError("authority-unavailable", "Introspection credential is unavailable");
    const method = credentials.authenticationMethod ?? "client_secret_basic";
    if (
      metadata.introspection_endpoint_auth_methods_supported &&
      !metadata.introspection_endpoint_auth_methods_supported.includes(method)
    ) {
      throw new AccessError("authority-unavailable", "Introspection authentication method is not supported");
    }
    const body = new URLSearchParams({ token, token_type_hint: "access_token" });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (method === "client_secret_post") {
      body.set("client_id", credentials.clientId);
      body.set("client_secret", secret);
    } else {
      const encode = (value: string): string => new URLSearchParams({ v: value }).toString().slice(2);
      headers.authorization = `Basic ${Buffer.from(`${encode(credentials.clientId)}:${encode(secret)}`).toString("base64")}`;
    }
    // Metadata/keys may be cached. Token activity and permission responses never are.
    const response = await this.#json(metadata.introspection_endpoint, { method: "POST", headers, body });
    if (
      response.active !== true ||
      typeof response.token_type !== "string" ||
      response.token_type.toLowerCase() !== "bearer"
    )
      throw new AccessError("unauthenticated", "Access token is inactive or has an unsupported type");
    if (response.iss !== undefined && response.iss !== configuration.issuer)
      throw new AccessError("unauthenticated", "Introspected issuer mismatch");
    return response;
  }
}
