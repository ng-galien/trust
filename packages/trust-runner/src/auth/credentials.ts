import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as oidc from "openid-client";
import { httpUrl } from "../http/request.js";

/** Private host configuration, never a Plan input, Operation Environment, or Fact. */
export interface RunnerCredential {
  readonly version: 1;
  readonly origin: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
  readonly clientSecret?: string;
  readonly resource?: string;
}

/** Loopback-only service credential for the embedded development authority. */
export interface DevelopmentRunnerCredential {
  readonly version: 2;
  readonly mode: "development-service";
  readonly origin: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface RunnerAuthorization {
  headers(endpoint: string): Promise<Readonly<Record<string, string>>>;
}

function credentialError(): Error {
  return new Error("Runner credential file must be private, valid, and bound to the configured runtime origin.");
}

function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16384 && /^[\x21-\x7e]+$/u.test(value);
}

export function parseRunnerCredential(value: unknown): RunnerCredential | DevelopmentRunnerCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw credentialError();
  const row = value as Record<string, unknown>;
  if (row.version === 2) {
    if (
      Object.keys(row).some((key) => !["version", "mode", "origin", "clientId", "clientSecret"].includes(key)) ||
      row.mode !== "development-service" ||
      typeof row.origin !== "string" ||
      typeof row.clientId !== "string" ||
      !/^[a-z][a-z0-9-]*$/u.test(row.clientId) ||
      !token(row.clientSecret) ||
      row.clientSecret.length < 32 ||
      row.clientSecret.length > 256
    )
      throw credentialError();
    const origin = httpUrl(row.origin);
    if (
      origin.origin !== row.origin ||
      origin.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
    )
      throw credentialError();
    return row as unknown as DevelopmentRunnerCredential;
  }
  const allowed = [
    "version",
    "origin",
    "issuer",
    "clientId",
    "accessToken",
    "expiresAt",
    "refreshToken",
    "clientSecret",
    "resource",
  ];
  if (
    Object.keys(row).some((key) => !allowed.includes(key)) ||
    row.version !== 1 ||
    typeof row.origin !== "string" ||
    typeof row.issuer !== "string" ||
    typeof row.clientId !== "string" ||
    !row.clientId ||
    !token(row.accessToken) ||
    typeof row.expiresAt !== "number" ||
    !Number.isSafeInteger(row.expiresAt) ||
    row.expiresAt < 0 ||
    (row.refreshToken !== undefined && !token(row.refreshToken)) ||
    (row.clientSecret !== undefined && !token(row.clientSecret)) ||
    (row.resource !== undefined && typeof row.resource !== "string")
  )
    throw credentialError();
  const origin = httpUrl(row.origin);
  if (origin.origin !== row.origin || origin.search || origin.hash) throw credentialError();
  const issuer = httpUrl(row.issuer);
  if (issuer.search || issuer.hash) throw credentialError();
  return row as unknown as RunnerCredential;
}

async function privateDirectory(file: string): Promise<void> {
  if (!path.isAbsolute(file)) throw credentialError();
  const directory = await lstat(path.dirname(file));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0 ||
    (process.getuid && directory.uid !== process.getuid())
  )
    throw credentialError();
}

export async function readPrivateJson(file: string): Promise<unknown> {
  await privateDirectory(file);
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 65536 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw credentialError();
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } catch {
    throw credentialError();
  } finally {
    await handle?.close();
  }
}

export async function readRunnerCredential(file: string): Promise<RunnerCredential | DevelopmentRunnerCredential> {
  return parseRunnerCredential(await readPrivateJson(file));
}

export async function writeRunnerCredential(file: string, credential: RunnerCredential): Promise<void> {
  await privateDirectory(file);
  const serialized = JSON.stringify(parseRunnerCredential(credential));
  const temporary = path.join(path.dirname(file), `.credential-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function runnerOidcConfiguration(
  credential: Pick<RunnerCredential, "issuer" | "clientId" | "clientSecret">,
): Promise<oidc.Configuration> {
  const issuer = httpUrl(credential.issuer);
  const configuration = await oidc.discovery(
    issuer,
    credential.clientId,
    credential.clientSecret,
    credential.clientSecret ? oidc.ClientSecretPost(credential.clientSecret) : oidc.None(),
    {
      execute: issuer.protocol === "http:" ? [oidc.allowInsecureRequests] : [],
      [oidc.customFetch]: async (input, init) => {
        const target = new URL(input);
        if (target.origin !== issuer.origin)
          throw new Error("OAuth endpoint must remain on the configured issuer origin.");
        const { body, ...request } = init;
        return fetch(input, { ...request, ...(body === undefined ? {} : { body }), redirect: "error" });
      },
    },
  );
  return configuration;
}

export function createRunnerAuthorization(
  environment: Readonly<Record<string, string | undefined>>,
  rpcEndpoint: string,
  otlpEndpoint: string,
): RunnerAuthorization | undefined {
  if (
    ["TRUST_ACCESS_TOKEN", "TRUST_REFRESH_TOKEN", "TRUST_AUTHORIZATION"].some((name) => environment[name] !== undefined)
  )
    throw new Error("Configure TRUST_AUTH_FILE; token values are not accepted in Runner environment variables.");
  const file = environment.TRUST_AUTH_FILE;
  if (file === undefined) return undefined;
  const rpc = httpUrl(rpcEndpoint);
  const otlp = httpUrl(otlpEndpoint);
  if (
    rpc.origin !== otlp.origin ||
    rpc.pathname !== "/rpc" ||
    rpc.search ||
    rpc.hash ||
    otlp.pathname !== "/v1/traces" ||
    otlp.search ||
    otlp.hash
  )
    throw new Error("Authenticated Runner RPC and OTLP must use the same configured origin and exact protocol paths.");
  let pending: Promise<string> | undefined;
  let developmentToken: { value: string; expiresAt: number } | undefined;
  const load = async (): Promise<string> => {
    const credential = await readRunnerCredential(file);
    if (credential.origin !== rpc.origin) throw credentialError();
    if (credential.version === 2) {
      if (developmentToken && developmentToken.expiresAt > Date.now() + 30_000) return developmentToken.value;
      const response = await fetch(`${credential.origin}/auth/dev/service-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: credential.clientId, secret: credential.clientSecret }),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Development Runner service authentication failed.");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || Array.isArray(result)) throw credentialError();
      const tokenResponse = result as Record<string, unknown>;
      if (
        !token(tokenResponse.accessToken) ||
        typeof tokenResponse.expiresIn !== "number" ||
        !Number.isSafeInteger(tokenResponse.expiresIn) ||
        tokenResponse.expiresIn < 31 ||
        tokenResponse.expiresIn > 120
      )
        throw credentialError();
      developmentToken = { value: tokenResponse.accessToken, expiresAt: Date.now() + tokenResponse.expiresIn * 1000 };
      return developmentToken.value;
    }
    if (credential.expiresAt > Date.now() + 30000) return credential.accessToken;
    if (!credential.refreshToken) throw new Error("Runner access token expired; renew the private credential file.");
    const lock = `${file}.lock`;
    const deadline = Date.now() + 10000;
    let handle: FileHandle | undefined;
    while (!handle) {
      try {
        handle = await open(lock, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline)
          throw new Error("Runner credential refresh is locked; verify the other process before retrying.");
        await delay(100);
      }
    }
    try {
      const latest = await readRunnerCredential(file);
      if (latest.origin !== rpc.origin || latest.version !== 1) throw credentialError();
      if (latest.expiresAt > Date.now() + 30000) return latest.accessToken;
      if (!latest.refreshToken) throw new Error("Runner credential cannot refresh.");
      const config = await runnerOidcConfiguration(latest);
      const result = await oidc.refreshTokenGrant(
        config,
        latest.refreshToken,
        latest.resource ? { resource: latest.resource } : undefined,
      );
      if (!result.access_token || !result.expires_in || result.token_type.toLowerCase() !== "bearer")
        throw new Error("Invalid token response.");
      const refreshed: RunnerCredential = {
        ...latest,
        accessToken: result.access_token,
        expiresAt: Date.now() + result.expires_in * 1000,
        refreshToken: result.refresh_token ?? latest.refreshToken,
      };
      await writeRunnerCredential(file, refreshed);
      return refreshed.accessToken;
    } catch {
      throw new Error("Runner credential refresh failed; authenticate again using the private credential helper.");
    } finally {
      await handle.close();
      await unlink(lock).catch(() => undefined);
    }
  };
  return {
    async headers(endpoint) {
      const target = httpUrl(endpoint);
      if (target.href !== rpc.href && target.href !== otlp.href)
        throw new Error("Runner authorization is restricted to its configured RPC and OTLP endpoints.");
      pending ??= load().finally(() => {
        pending = undefined;
      });
      const accessToken = await pending;
      return { authorization: `Bearer ${accessToken}` };
    },
  };
}
