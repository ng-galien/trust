import {
  type AccessConfiguration,
  type AccessContext,
  type ExternalPrincipal,
  extensionUseScope,
  type PlanAccessScope,
  parseAccessConfiguration,
} from "@trust/extension-sdk";
import { matchAccessConfiguration, matchAccessContext } from "@trust/extension-sdk/match";
import type { Clock } from "../time.js";
import { type AccessFetch, type AccessSecretResolver } from "./configuration.js";
import { AccessError } from "./error.js";
import { accessPlanScope, authorizeAccess } from "./policy.js";
import { AccessProvider } from "./provider.js";

export { samePrincipal } from "./policy.js";

export interface AccessServiceDependencies {
  readonly accessConfiguration: AccessConfiguration;
  readonly clock: Clock;
  readonly accessFetch: AccessFetch;
  readonly accessSecretResolver: AccessSecretResolver;
}

const localContext: AccessContext = Object.freeze({ mode: "local" });

/** Shared authentication and fixed authorization authority; never holds a current actor. */
export class AccessService {
  readonly #configuration: AccessConfiguration;
  readonly #provider: AccessProvider | undefined;
  readonly #contexts = new WeakSet<AccessContext>();
  readonly shared: boolean;

  constructor(private readonly dependencies: AccessServiceDependencies) {
    this.#configuration = parseAccessConfiguration(dependencies.accessConfiguration);
    this.#provider = matchAccessConfiguration(this.#configuration, {
      local: () => undefined,
      "local-jwt": (configuration) =>
        new AccessProvider(
          configuration,
          dependencies.clock,
          dependencies.accessFetch,
          dependencies.accessSecretResolver,
        ),
      introspection: (configuration) =>
        new AccessProvider(
          configuration,
          dependencies.clock,
          dependencies.accessFetch,
          dependencies.accessSecretResolver,
        ),
    });
    this.shared = this.#provider !== undefined;
  }

  async authenticate(authorizationHeader: string | undefined): Promise<AccessContext> {
    const configuration = matchAccessConfiguration<Exclude<AccessConfiguration, { mode: "local" }> | undefined>(
      this.#configuration,
      { local: () => undefined, "local-jwt": (value) => value, introspection: (value) => value },
    );
    if (!configuration) return localContext;
    if (
      typeof authorizationHeader !== "string" ||
      !/^Bearer [A-Za-z0-9\-._~+/]+=*$/i.test(authorizationHeader) ||
      authorizationHeader.length > 32_768
    ) {
      throw new AccessError("unauthenticated", "A bearer access token is required");
    }
    const token = authorizationHeader.slice(7);
    if (!this.#provider) throw new AccessError("authority-unavailable", "Access authority unavailable");
    const provider = this.#provider;
    const claims = await matchAccessConfiguration(configuration, {
      local: () => {
        throw new AccessError("unauthenticated", "Local authentication cannot validate a token");
      },
      "local-jwt": () => provider.verifyJwt(token),
      introspection: () => provider.introspect(token),
    });
    const now = this.dependencies.clock.now().getTime() / 1000;
    const validText = (value: unknown): value is string =>
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in authenticated identity claims.
      typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
    const audience = claims.aud;
    if (
      !validText(claims.sub) ||
      (typeof audience !== "string" && (!Array.isArray(audience) || audience.some((value) => !validText(value)))) ||
      !(Array.isArray(audience) ? audience.includes(configuration.audience) : audience === configuration.audience)
    ) {
      throw new AccessError("unauthenticated", "Access token identity or audience is invalid");
    }
    if (
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" ||
          !Number.isFinite(claims.nbf) ||
          claims.nbf > now + (configuration.clockToleranceSeconds ?? 0)))
    ) {
      throw new AccessError("unauthenticated", "Access token lifetime is invalid");
    }
    if (
      claims.iat !== undefined &&
      (typeof claims.iat !== "number" ||
        !Number.isFinite(claims.iat) ||
        claims.iat > now + (configuration.clockToleranceSeconds ?? 0) ||
        now - claims.iat > (configuration.maxTokenAgeSeconds ?? 300) + (configuration.clockToleranceSeconds ?? 0) ||
        claims.exp - claims.iat > (configuration.maxTokenAgeSeconds ?? 300))
    ) {
      throw new AccessError("unauthenticated", "Access token age is invalid");
    }
    if (
      typeof claims.scope !== "string" ||
      (claims.scope !== "" && !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(claims.scope))
    ) {
      throw new AccessError("unauthenticated", "Access token scopes are invalid");
    }
    if (claims.client_id !== undefined && !validText(claims.client_id))
      throw new AccessError("unauthenticated", "Access token client is invalid");
    if (claims.jti !== undefined && !validText(claims.jti))
      throw new AccessError("unauthenticated", "Access token identifier is invalid");
    const context: AccessContext = Object.freeze({
      mode: "authenticated",
      principal: Object.freeze({ issuer: configuration.issuer, subject: claims.sub }),
      ...(typeof claims.client_id === "string" ? { clientId: claims.client_id } : {}),
      scopes: Object.freeze([...new Set(claims.scope === "" ? [] : claims.scope.split(" "))]),
      expiresAt: claims.exp,
      verifiedAt: now,
      verification: configuration.mode,
    });
    this.#contexts.add(context);
    return context;
  }

  #context(context: AccessContext | undefined): AccessContext {
    if (!this.shared) return localContext;
    if (!context || typeof context !== "object" || !this.#contexts.has(context))
      throw new AccessError("unauthenticated", "Verified request context is required");
    return matchAccessContext(context, {
      local: () => {
        throw new AccessError("unauthenticated", "Local context is not valid in shared mode");
      },
      authenticated: (authenticated) => {
        if (authenticated.expiresAt <= this.dependencies.clock.now().getTime() / 1000)
          throw new AccessError("unauthenticated", "Access token has expired");
        return authenticated;
      },
    });
  }

  authorize(context: AccessContext | undefined, action: string, owner?: ExternalPrincipal | null): void {
    authorizeAccess(this.#context(context), action, owner);
  }

  /** Extension data use is distinct from lifecycle and every core Plan permission. */
  authorizeExtension(context: AccessContext | undefined, extensionId: string): void {
    this.authorize(context, extensionUseScope(extensionId).slice("trust.".length));
  }

  planScope(context: AccessContext | undefined, action: string): PlanAccessScope {
    return accessPlanScope(this.#context(context), action);
  }

  principal(context: AccessContext | undefined): ExternalPrincipal | null {
    return matchAccessContext(this.#context(context), { local: () => null, authenticated: (value) => value.principal });
  }
}
