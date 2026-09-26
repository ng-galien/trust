import { createServer } from "node:http";
import * as oidc from "openid-client";
import { httpUrl } from "../http/request.js";
import { readPrivateJson, runnerOidcConfiguration, writeRunnerCredential } from "./credentials.js";

/** Host-side browser login. The callback, token and refresh secret never enter stdout. */
export async function runAuthenticationCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const configFile = argv[1];
    const output = argv[3];
    if (argv.length !== 4 || argv[0] !== "--config" || argv[2] !== "--output" || !configFile || !output)
      throw new Error("usage: auth.js --config <private-config.json> --output <private-credential.json>");
    const input = await readPrivateJson(configFile);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid authentication configuration.");
    const row = input as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) => !["issuer", "clientId", "clientSecret", "origin", "resource", "scope", "redirectUri"].includes(key),
      ) ||
      ["issuer", "clientId", "origin", "resource", "scope", "redirectUri"].some(
        (key) => typeof row[key] !== "string" || !row[key],
      ) ||
      (row.clientSecret !== undefined && typeof row.clientSecret !== "string")
    )
      throw new Error("Invalid authentication configuration.");
    const issuer = row.issuer as string;
    const clientId = row.clientId as string;
    const clientSecret = row.clientSecret as string | undefined;
    const origin = httpUrl(row.origin as string);
    const redirect = httpUrl(row.redirectUri as string);
    if (
      origin.origin !== row.origin ||
      redirect.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname) ||
      redirect.search ||
      redirect.hash ||
      !redirect.port
    )
      throw new Error("Use an exact runtime origin and an explicit loopback callback port.");
    const configuration = await runnerOidcConfiguration({
      issuer,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    });
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const resource = row.resource as string;
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: redirect.href,
      scope: `openid offline_access ${row.scope}`,
      prompt: "consent",
      resource,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    let resolveCallback!: (url: URL) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<URL>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    const server = createServer((request, response) => {
      const target = new URL(request.url ?? "/", redirect.origin);
      if (
        request.method !== "GET" ||
        target.pathname !== redirect.pathname ||
        request.headers.host !== redirect.host ||
        target.searchParams.get("state") !== state
      ) {
        response.writeHead(400).end("Invalid authentication callback.");
        return;
      }
      response
        .writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", "referrer-policy": "no-referrer" })
        .end("Authentication received. You can close this window.");
      resolveCallback(target);
    });
    const timeout = setTimeout(() => rejectCallback(new Error("Authentication timed out.")), 180_000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(redirect.port), redirect.hostname === "[::1]" ? "::1" : redirect.hostname, resolve);
      });
      process.stdout.write(`Open this authorization URL in your browser:\n${url.href}\n`);
      const result = await oidc.authorizationCodeGrant(
        configuration,
        await callback,
        { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce },
        { resource },
      );
      if (!result.access_token || !result.expires_in || result.token_type.toLowerCase() !== "bearer")
        throw new Error("Invalid token response.");
      await writeRunnerCredential(output, {
        version: 1,
        origin: origin.origin,
        issuer,
        clientId,
        resource,
        accessToken: result.access_token,
        expiresAt: Date.now() + result.expires_in * 1000,
        ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      });
      process.stdout.write("Private Runner credential saved. Configure TRUST_AUTH_FILE to its absolute path.\n");
      return 0;
    } finally {
      clearTimeout(timeout);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } catch {
    process.stderr.write(
      "Authentication failed. Check the private configuration, callback, provider and file permissions. No credential was printed.\n",
    );
    return 1;
  }
}

if (process.argv[1] && /(?:^|[/\\])auth\.js$/u.test(process.argv[1])) process.exitCode = await runAuthenticationCli();
