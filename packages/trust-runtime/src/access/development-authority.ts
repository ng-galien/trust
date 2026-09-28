import { createHash, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import type { DevelopmentAuthenticationConfiguration } from "@trust/extension-sdk";
import { type JWTPayload, jwtVerify, SignJWT } from "jose";
import type { Clock } from "../time.js";
import { AccessError } from "./error.js";

const TOKEN_SECONDS = 120;
const SESSION_SECONDS = 8 * 60 * 60;

export class DevelopmentAuthority {
  readonly #privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  readonly #publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
  readonly #sessionKey = randomBytes(32);
  readonly #revokedSessions = new Map<string, number>();
  #codeExchange: Promise<void> = Promise.resolve();

  constructor(
    private readonly configuration: DevelopmentAuthenticationConfiguration,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly clock: Clock,
  ) {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = keys.privateKey;
    this.#publicKey = keys.publicKey;
  }

  get tailnetOrigin(): string {
    return this.configuration.tailnetOrigin;
  }

  async #accessToken(subject: string, scopes: readonly string[], clientId: string): Promise<string> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({ scope: scopes.join(" "), client_id: clientId, jti: randomUUID() })
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt" })
      .setIssuer(this.issuer)
      .setSubject(subject)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + TOKEN_SECONDS)
      .sign(this.#privateKey);
  }

  async verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.#publicKey, {
        algorithms: ["RS256"],
        issuer: this.issuer,
        audience: this.audience,
        typ: "at+jwt",
        currentDate: this.clock.now(),
        maxTokenAge: TOKEN_SECONDS,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "scope", "client_id", "jti"],
      });
      return payload;
    } catch {
      throw new AccessError("unauthenticated", "Development access token validation failed");
    }
  }

  async issueForTailnet(login: string): Promise<string> {
    const user = this.configuration.users.find((item) => item.login === login.toLowerCase());
    if (!user) throw new AccessError("forbidden", "Tailnet identity is not allowed for development access");
    return this.#accessToken(user.subject, user.scopes, "trust-dev-browser");
  }

  async issueForService(clientId: string, secret: string): Promise<string> {
    const service = this.configuration.services.find((item) => item.clientId === clientId);
    if (!service || secret.length < 32 || secret.length > 256)
      throw new AccessError("unauthenticated", "Development service credential is invalid");
    try {
      const expected = (await readFile(service.secretFile, "utf8")).trim();
      const actualHash = createHash("sha256").update(secret).digest();
      const expectedHash = createHash("sha256").update(expected).digest();
      if (!timingSafeEqual(actualHash, expectedHash)) throw new Error("Wrong credential");
      return this.#accessToken(service.subject, service.scopes, clientId);
    } catch {
      throw new AccessError("unauthenticated", "Development service credential is invalid");
    }
  }

  async issueForLocalSession(session: string): Promise<string> {
    try {
      const payload = await this.#localSession(session);
      if (typeof payload.jti !== "string" || this.#revokedSessions.has(payload.jti))
        throw new Error("Revoked local session");
      return this.#accessToken(this.configuration.local.subject, this.configuration.local.scopes, "trust-dev-browser");
    } catch {
      throw new AccessError("unauthenticated", "Local development session is invalid");
    }
  }

  async #localSession(session: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(session, this.#sessionKey, {
      algorithms: ["HS256"],
      issuer: this.issuer,
      audience: "urn:trust:development-session",
      typ: "trust-dev-session+jwt",
      currentDate: this.clock.now(),
      maxTokenAge: SESSION_SECONDS,
      requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti"],
    });
    if (payload.sub !== this.configuration.local.subject) throw new Error("Wrong local principal");
    return payload;
  }

  async revokeLocalSession(session: string): Promise<void> {
    try {
      const payload = await this.#localSession(session);
      if (typeof payload.jti === "string" && typeof payload.exp === "number") {
        const now = Math.floor(this.clock.now().getTime() / 1000);
        for (const [id, expiry] of this.#revokedSessions) if (expiry <= now) this.#revokedSessions.delete(id);
        this.#revokedSessions.set(payload.jti, payload.exp);
      }
    } catch {
      // Clearing an already invalid cookie remains safe and idempotent.
    }
  }

  async issueForLocalCode(code: string): Promise<{ token: string; session: string }> {
    let release!: () => void;
    const prior = this.#codeExchange;
    this.#codeExchange = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const raw = JSON.parse(await readFile(this.configuration.local.codeFile, "utf8")) as {
        codeHash?: unknown;
        expiresAt?: unknown;
      };
      const actual = createHash("sha256").update(code).digest();
      const expected =
        typeof raw.codeHash === "string" && /^[a-f0-9]{64}$/.test(raw.codeHash)
          ? Buffer.from(raw.codeHash, "hex")
          : Buffer.alloc(32);
      if (
        typeof raw.expiresAt !== "number" ||
        raw.expiresAt <= this.clock.now().getTime() ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error("Invalid or expired code");
      await unlink(this.configuration.local.codeFile);
      const now = Math.floor(this.clock.now().getTime() / 1000);
      const session = await new SignJWT({ jti: randomUUID() })
        .setProtectedHeader({ alg: "HS256", typ: "trust-dev-session+jwt" })
        .setIssuer(this.issuer)
        .setSubject(this.configuration.local.subject)
        .setAudience("urn:trust:development-session")
        .setIssuedAt(now)
        .setExpirationTime(now + SESSION_SECONDS)
        .sign(this.#sessionKey);
      return {
        token: await this.#accessToken(
          this.configuration.local.subject,
          this.configuration.local.scopes,
          "trust-dev-browser",
        ),
        session,
      };
    } catch {
      throw new AccessError("unauthenticated", "Local development code is invalid or expired");
    } finally {
      release();
    }
  }
}
