# Development identity and private Runner authentication

This opt-in fixture exercises the same authenticated runtime authority as a configured external issuer. It uses `oidc-provider` 9.12.2 in one Node process with ephemeral signing keys, sessions and clients. `openid-client` 6.8.8 performs authorization code with PKCE and refresh; no custom token endpoint, unsigned token acceptance or runtime bypass is provided.

The development login accepts one of the fixed account names `alice`, `bob`, `admin`. Its built-in form requires any non-empty dummy password, which the provider ignores. Alice and Bob have own-Plan capabilities, catalog read/list access and explicit general use scopes for coordination, mobile companion and Dragon Heist; admin has all configured capabilities. Fixed service clients use randomly generated private client secrets. Requested scopes remain limited by client, account and grant. This login is suitable only for the explicit loopback development profile. Restarting the provider invalidates its keys, sessions, grants and private client configuration.

## Start a separate development instance

Use the installed maintained Node LTS release, an empty owner-only directory (`0700`) and the built Runner skill. The launcher refuses missing opt-in, non-private output and existing configuration files. It does not start or reconfigure any TRUST runtime.

```sh
node scripts/auth-development-server.mjs --enable-development --directory /absolute/private/directory
```

The issuer listens on `http://127.0.0.1:4521`. The generated `runtime-access.json` is the shell configuration wrapper for a separately launched runtime at port 4530; the public browser client returns to `http://127.0.0.1:4181/auth/callback`. The Runner public client returns to `http://127.0.0.1:4522/callback`. `startDevelopmentProvider` accepts explicit loopback browser/callback overrides for isolated tests. No existing runtime or enterprise configuration changes automatically.

The private directory contains runtime configuration, browser public configuration, Runner login configuration, and random private service/introspection client secrets. Keep it out of source control. The local JWT runtime configuration contains no client secret. A configured introspection authority resolves its client secret from its own protected server credential reference; the fixture does not install that reference into any retained Environment.

## Acquire and renew a private Runner credential

```sh
node scripts/auth-development-login.mjs --config /absolute/private/directory/runner-login.json --output /absolute/private/directory/runner-credential.json
```

Open the printed authorization URL, choose a fixed account and approve the requested scopes. The helper validates state, nonce and PKCE with the maintained OAuth client and receives the callback on loopback. The output reports success without printing access tokens, refresh tokens or client secrets. Both the login configuration and credential files require an owner-only regular file and private parent directory; symlinks, hard links and group/other access are rejected on reads.

Set `TRUST_AUTH_FILE` to the absolute credential path, `TRUST_RPC_ENDPOINT` to the intended runtime's `/rpc`, and `TRUST_OTLP_ENDPOINT` to the same origin's `/v1/traces`. Invoke the existing packaged Runner with the unchanged supplied semantic Check URI. Credentials are not URI parameters, Plan inputs, Facts or Operation Environment values. Direct `TRUST_ACCESS_TOKEN`, `TRUST_REFRESH_TOKEN` and `TRUST_AUTHORIZATION` variables are refused.

The private credential stores version 1, exact runtime `origin`, trusted `issuer`, OAuth `clientId`, `accessToken`, millisecond `expiresAt`, optional `refreshToken`, optional confidential `clientSecret`, and `resource`. Before expiry the helper refreshes via discovered endpoints on the configured issuer origin. It writes rotated credentials atomically with mode `0600`; an exclusive file lock coordinates concurrent processes. A stale lock fails closed and requires the operator to verify the other process before removing it. Authentication errors are sanitized.

Only the exact configured RPC and OTLP URLs receive the bearer header. HTTP redirects are not followed. Operation HTTP calls do not receive Runner authorization, and Shell child environments strip every `TRUST_` variable. This isolates accidental forwarding; an external program running as the same OS user is not sandboxed from files the user can read.

## Two explicit resource profiles

| Resource | Token | Runtime mode | Revocation behavior |
| --- | --- | --- | --- |
| `urn:trust:runtime` | Signed RS256 JWT, `typ: at+jwt`, 120 seconds | `local-jwt` | Locally validated token remains usable until its bounded expiry; a refresh grant can be revoked |
| `urn:trust:runtime:introspection` | Opaque access token, audience `urn:trust:runtime` | `introspection` | Provider reports actual active state; revocation invalidates the grant and refresh |

The maintained provider deliberately refuses JWT access-token introspection. The fixture does not invent a wrapper to emulate it. Fixed resource profiles share an audience but select different token formats. Production issuer and runtime profiles require independently configured accounts, clients, HTTPS endpoints, permissions and protected credentials.

## Evidence and limits

The three named development acceptances are in `packages/trust-runtime/acceptance/access-development-*.test.mjs`. They cover the real packaged `auth.js` acquiring a private credential through its loopback callback (including invalid-state refusal and listener shutdown), packaged Runner refresh of that credential, actual PKCE issuance, JWKS signature verification and tamper rejection, account scope ceilings, opaque revocation, private credential reads and refresh, the packaged Runner through authenticated RPC and OTLP, external Shell/HTTP isolation, redirect refusal, and persisted creator/actor plus rejected foreign OTLP on disposable PGlite and PostgreSQL databases.

The unit-labelled test includes real provider protocol operations; its layer label describes its mission group, not proof of isolation from services. The integration and database tests use real runtime containers with HTTP listeners and real storage, while the external Check reads Git metadata without changing the checkout. The database test explicitly creates and drops uniquely named disposable databases, never the connection's existing coordination database.

The test support bundles Runner source into a fresh temporary module for credential and transport assertions; the public execution also calls `dist/skill/trust/scripts/run.js`. Governed verification hashes both source and packaged artifacts after the coordinator's build freeze. Provider HTML interactions are driven through HTTP in the packaged CLI test; a real desktop browser is outside that test. Production accounts and a deployed enterprise provider are also outside these tests. Reviewer identity remains procedural until the separate authenticated coordination design is implemented.

Upstream references: [oidc-provider](https://github.com/panva/node-oidc-provider), [openid-client](https://github.com/panva/openid-client).


## Provider lifecycle limits

This fixture does not expose account administration, live account disablement, or live permission editing. Fixed account and client ceilings are installed at process start; changing source/configuration and restarting creates a new development issuer state. Controlled authority fixtures elsewhere can test TRUST rejection of changed claims or inactive introspection results, but those observations are not evidence that this development provider implements an account-management product.

The genuine provider behavior established here is code/PKCE issuance, grant-scoped permissions, refresh, opaque introspection and grant revocation. Revoking the opaque grant prevents further refresh and reports its access token inactive. JWT access tokens intentionally remain bounded by their signed expiry under local verification. The browser has registered logout callbacks, but this suite does not exercise an end-session journey; logout must not be described as global access-token or offline-grant revocation. No current test claims recovery of provider state across process restart: state is intentionally ephemeral.

## Subsequent configuration milestone

This report records the earlier ABAC verification state. The later server-configuration work retires `TRUST_AUTH_CONFIG_FILE` in favor of the `authentication` section selected by `TRUST_CONFIG_FILE`; the development launcher now writes `runtime-configuration.json`. See the [current operator reference](../../../reference/server-configuration.md). These later changes have their own verification and do not rewrite this report's historical evidence.
