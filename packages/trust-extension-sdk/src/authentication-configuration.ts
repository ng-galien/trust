import { type AccessConfiguration, authorityUrl, parseAccessConfiguration } from "./access-configuration.js";
import type { BrowserAuthenticationConfiguration } from "./browser-authentication.js";

export interface AuthenticationConfiguration {
  readonly profile: "local" | "development" | "shared";
  readonly access: AccessConfiguration;
  readonly browser?: BrowserAuthenticationConfiguration;
  readonly resourceUrl?: string;
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
  onlyKeys(input, ["profile", "access", "browser", "resourceUrl"]);
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
  if (access.mode === "local") throw new TypeError("An authentication configuration cannot disable validation");
  if (input.profile === "shared" && access.allowInsecureLoopback)
    throw new TypeError("Shared authentication refuses development loopback configuration");
  if (!text(input.resourceUrl)) throw new TypeError("Authentication resourceUrl is required");
  authorityUrl(input.resourceUrl, input.profile === "development");
  let browser: BrowserAuthenticationConfiguration | undefined;
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
  });
}
