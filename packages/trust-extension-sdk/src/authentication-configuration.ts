import { type AccessConfiguration, authorityUrl, parseAccessConfiguration } from "./access-configuration.js";
import type { BrowserAuthenticationConfiguration } from "./browser-authentication.js";

export interface AuthenticationConfiguration {
  readonly profile: "local" | "fixed" | "development" | "shared";
  readonly access: AccessConfiguration;
  readonly browser?: BrowserAuthenticationConfiguration;
  readonly resourceUrl?: string;
  readonly development?: DevelopmentAuthenticationConfiguration;
}

export interface DevelopmentPrincipalConfiguration {
  readonly subject: string;
  readonly scopes: readonly string[];
}

export interface DevelopmentAuthenticationConfiguration {
  readonly tailnetOrigin: string;
  readonly users: readonly (DevelopmentPrincipalConfiguration & { readonly login: string })[];
  readonly local: DevelopmentPrincipalConfiguration & { readonly codeFile: string };
  readonly services: readonly (DevelopmentPrincipalConfiguration & {
    readonly clientId: string;
    readonly secretFile: string;
  })[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Authentication configuration must be an object");
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new TypeError("Unknown authentication configuration field");
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === value;
}

export function parseAuthenticationConfiguration(value: unknown): AuthenticationConfiguration {
  const input = record(value);
  onlyKeys(input, ["profile", "access", "browser", "resourceUrl", "development"]);
  if (input.profile === "fixed") {
    onlyKeys(input, ["profile", "access"]);
    const access = parseAccessConfiguration(input.access);
    if (access.mode !== "fixed") throw new TypeError("Fixed authentication requires fixed access");
    return Object.freeze({ profile: "fixed", access });
  }
  if (input.profile === "local") {
    if (
      Object.keys(input).some((key) => !["profile", "access"].includes(key)) ||
      (input.access !== undefined && parseAccessConfiguration(input.access).mode !== "local")
    )
      throw new TypeError("Local authentication cannot include shared settings");
    return Object.freeze({ profile: "local", access: Object.freeze({ mode: "local" }) });
  }
  if (input.profile !== "development" && input.profile !== "shared")
    throw new TypeError("Authentication profile must be development or shared");
  const access = parseAccessConfiguration(input.access);
  if (access.mode === "local" || access.mode === "fixed")
    throw new TypeError("An authentication configuration cannot disable validation");
  if (input.profile === "shared" && access.allowInsecureLoopback)
    throw new TypeError("Shared authentication refuses development loopback configuration");
  if (!text(input.resourceUrl)) throw new TypeError("Authentication resourceUrl is required");
  authorityUrl(input.resourceUrl, input.profile === "development");
  let browser: BrowserAuthenticationConfiguration | undefined;
  let development: DevelopmentAuthenticationConfiguration | undefined;
  if (input.development !== undefined) {
    if (
      input.profile !== "development" ||
      input.browser !== undefined ||
      access.mode !== "local-jwt" ||
      access.allowInsecureLoopback ||
      (access.maxTokenAgeSeconds ?? 300) < 120 ||
      (access.algorithms !== undefined && (access.algorithms.length !== 1 || access.algorithms[0] !== "RS256")) ||
      (access.tokenProfile !== undefined &&
        (access.tokenProfile.headerType !== "at+jwt" ||
          Object.keys(access.tokenProfile.requiredClaims ?? {}).length !== 0))
    )
      throw new TypeError("Embedded development authentication requires development profile and strict JWT access");
    const raw = record(input.development);
    onlyKeys(raw, ["tailnetOrigin", "users", "local", "services"]);
    if (!text(raw.tailnetOrigin)) throw new TypeError("Development tailnet origin is required");
    const origin = authorityUrl(raw.tailnetOrigin);
    if (
      origin.origin !== raw.tailnetOrigin ||
      origin.pathname !== "/" ||
      access.issuer !== `${raw.tailnetOrigin}/auth/dev`
    )
      throw new TypeError("Development issuer and tailnet origin must share one HTTPS authority");
    const principal = (value: unknown, extras: readonly string[]): DevelopmentPrincipalConfiguration => {
      const item = record(value);
      onlyKeys(item, ["subject", "scopes", ...extras]);
      if (
        !text(item.subject) ||
        !Array.isArray(item.scopes) ||
        item.scopes.some((scope) => !text(scope) || !/^trust\.[a-z0-9.-]+$/.test(scope))
      )
        throw new TypeError("Invalid development principal or scopes");
      return { subject: item.subject, scopes: Object.freeze([...new Set(item.scopes as string[])]) };
    };
    if (!Array.isArray(raw.users)) throw new TypeError("Development users must be an array");
    const users = raw.users.map((value) => {
      const item = record(value);
      const identity = principal(item, ["login"]);
      if (!text(item.login) || item.login !== item.login.toLowerCase() || !/^[a-z0-9._+@-]+$/.test(item.login))
        throw new TypeError("Invalid development tailnet login");
      return Object.freeze({ ...identity, login: item.login });
    });
    if (new Set(users.map((user) => user.login)).size !== users.length)
      throw new TypeError("Duplicate development tailnet login");
    const local = record(raw.local);
    const localPrincipal = principal(local, ["codeFile"]);
    if (!text(local.codeFile) || !local.codeFile.startsWith("/"))
      throw new TypeError("Development local codeFile must be absolute");
    if (!Array.isArray(raw.services)) throw new TypeError("Development services must be an array");
    const services = raw.services.map((value) => {
      const item = record(value);
      const identity = principal(item, ["clientId", "secretFile"]);
      if (
        !text(item.clientId) ||
        !/^[a-z][a-z0-9-]*$/.test(item.clientId) ||
        !text(item.secretFile) ||
        !item.secretFile.startsWith("/")
      )
        throw new TypeError("Invalid development service identity or secretFile");
      return Object.freeze({ ...identity, clientId: item.clientId, secretFile: item.secretFile });
    });
    if (new Set(services.map((service) => service.clientId)).size !== services.length)
      throw new TypeError("Duplicate development service clientId");
    development = Object.freeze({
      tailnetOrigin: raw.tailnetOrigin,
      users: Object.freeze(users),
      local: Object.freeze({ ...localPrincipal, codeFile: local.codeFile }),
      services: Object.freeze(services),
    });
  }
  if (input.browser !== undefined) {
    const client = record(input.browser);
    onlyKeys(client, ["issuer", "clientId", "redirectUri", "postLogoutRedirectUri", "scope", "resource"]);
    if (
      client.issuer !== access.issuer ||
      !text(client.clientId) ||
      !text(client.redirectUri) ||
      !text(client.postLogoutRedirectUri) ||
      !text(client.scope)
    ) {
      throw new TypeError("Browser authentication requires the configured issuer, public client, redirects and scopes");
    }
    const redirect = authorityUrl(client.redirectUri, input.profile === "development");
    const logout = authorityUrl(client.postLogoutRedirectUri, input.profile === "development");
    if (redirect.origin !== logout.origin)
      throw new TypeError("Browser login and logout redirects must share an origin");
    if (client.resource !== undefined && !text(client.resource))
      throw new TypeError("Browser resource must be a non-empty identifier");
    browser = Object.freeze({
      issuer: client.issuer,
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      postLogoutRedirectUri: client.postLogoutRedirectUri,
      scope: client.scope,
      ...(typeof client.resource === "string" ? { resource: client.resource } : {}),
    });
  }
  return Object.freeze({
    profile: input.profile,
    access,
    resourceUrl: input.resourceUrl,
    ...(browser ? { browser } : {}),
    ...(development ? { development } : {}),
  });
}
